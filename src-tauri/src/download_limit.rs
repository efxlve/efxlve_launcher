//! A real bandwidth cap for every download the launcher runs.
//!
//! legendary, gogdl and nile have no rate-limit flag, but they use `requests`,
//! which honours `HTTPS_PROXY`. Those children are pointed at this loopback
//! proxy, and one shared token bucket paces every tunnel and plain HTTP
//! request they open. EA and Ubisoft direct installs run in this process and
//! call [`throttle`] from their own download loops, so they feed the same
//! bucket. Only the download direction is capped; request bytes are tiny.
//!
//! The listener is created once at startup and stays idle until a limit is set.

use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};

/// Longest CONNECT header block we accept before giving up.
const MAX_HEAD: usize = 16 * 1024;
const READ_CHUNK: usize = 16 * 1024;
/// How many bytes per second one Mbit/s is.
const BPS_PER_MBPS: f64 = 125_000.0;

static RATE_BPS: AtomicU64 = AtomicU64::new(0);
/// 0 until the listener is bound.
static PORT: AtomicU16 = AtomicU16::new(0);
static BUCKET: Mutex<Bucket> = Mutex::new(Bucket::new());

/// Binds the loopback listener and applies the stored limit.
///
/// Called once from setup. A failure leaves the port at 0, so downloads simply
/// run without a cap instead of breaking.
pub fn init(mbps: f64) {
    set_rate(mbps);
    let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", 0)) else {
        return;
    };
    let Ok(addr) = listener.local_addr() else {
        return;
    };
    if listener.set_nonblocking(true).is_err() {
        return;
    }
    PORT.store(addr.port(), Ordering::Relaxed);
    tauri::async_runtime::spawn(async move {
        let Ok(listener) = TcpListener::from_std(listener) else {
            return;
        };
        serve(listener).await;
    });
}

/// Sets the cap in Mbit/s. 0 (or a negative value) means unlimited.
///
/// A positive value below 0.1 Mbit/s is raised to 0.1: at 16 KiB per relay
/// chunk a smaller rate can make one chunk wait longer than legendary's 10 s
/// download timeout, which turns the cap into an endless retry loop.
pub fn set_rate(mbps: f64) {
    let bps = bps_for_rate(mbps);
    RATE_BPS.store(bps, Ordering::Relaxed);
    if let Ok(mut bucket) = BUCKET.lock() {
        bucket.configure(bps);
    }
}

/// Bytes/sec for a user-facing Mbit/s value, with the timeout-safe floor.
fn bps_for_rate(mbps: f64) -> u64 {
    if mbps.is_finite() && mbps > 0.0 {
        (mbps.max(0.1) * BPS_PER_MBPS).round() as u64
    } else {
        0
    }
}

/// The proxy URL every store CLI should use, or `None` if the listener could
/// not be bound. It is returned even at 0 Mbit/s: routing every transfer
/// through the relay from the start is what lets a cap set during a running
/// download take effect on the next chunk instead of the next install.
pub fn proxy_url() -> Option<String> {
    let port = PORT.load(Ordering::Relaxed);
    (port != 0).then(|| format!("http://127.0.0.1:{port}"))
}

/// The current cap in Mbit/s; 0 means unlimited.
pub fn rate_mbps() -> f64 {
    RATE_BPS.load(Ordering::Relaxed) as f64 / BPS_PER_MBPS
}

/// Points a store CLI at the loopback proxy, even while the cap is 0.
///
/// `HTTP_PROXY` matters too: some CDN URLs are plain HTTP, and the proxy
/// forwards those as well as CONNECT tunnels. A stale NO_PROXY entry would
/// send store traffic around the cap, so both spellings are cleared.
pub fn configure_child(cmd: &mut tokio::process::Command) {
    if let Some(proxy) = proxy_url() {
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
            cmd.env(key, &proxy);
        }
        cmd.env("NO_PROXY", "").env("no_proxy", "");
    }
}

/// Waits as long as the shared bucket needs for `bytes`.
///
/// Downloaders that run inside this process (EA, Ubisoft direct) call this
/// while they stream, so their traffic shares one cap with the proxied CLIs.
pub async fn throttle(bytes: usize) {
    let wait = BUCKET
        .lock()
        .map(|mut bucket| bucket.reserve(bytes))
        .unwrap_or(Duration::ZERO);
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

async fn serve(listener: TcpListener) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(handle(stream));
            }
            // A transient accept error must not kill the listener; without a
            // small pause a broken socket would spin this loop.
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

async fn handle(mut client: TcpStream) {
    let Some((head, rest)) = read_head(&mut client).await else {
        return;
    };
    let first_line = head.lines().next().unwrap_or("");
    if let Some((host, port)) = parse_connect(first_line) {
        tunnel(client, &host, port, &rest).await;
    } else if let Some((host, port, request_line)) = parse_http_forward(first_line) {
        forward(client, &head, &rest, &host, port, &request_line).await;
    } else {
        let _ = client
            .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n")
            .await;
    }
}

/// Relays one CONNECT tunnel.
async fn tunnel(mut client: TcpStream, host: &str, port: u16, rest: &[u8]) {
    let Ok(mut upstream) = TcpStream::connect((host, port)).await else {
        let _ = client
            .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            .await;
        return;
    };
    if client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .is_err()
    {
        return;
    }
    // A client may pipeline TLS bytes right behind the CONNECT line.
    if !rest.is_empty() && upstream.write_all(rest).await.is_err() {
        return;
    }
    let (client_read, client_write) = client.into_split();
    let (upstream_read, upstream_write) = upstream.into_split();
    tokio::join!(
        relay(client_read, upstream_write, false),
        relay(upstream_read, client_write, true),
    );
}

/// Relays one plain HTTP request. The absolute URI in a proxy request line is
/// rewritten to origin form before it reaches the server.
async fn forward(
    mut client: TcpStream,
    head: &str,
    rest: &[u8],
    host: &str,
    port: u16,
    request_line: &str,
) {
    let Ok(mut upstream) = TcpStream::connect((host, port)).await else {
        let _ = client
            .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            .await;
        return;
    };
    let headers = head.split_once("\r\n").map(|(_, tail)| tail).unwrap_or("");
    let mut request = String::with_capacity(head.len() + 32);
    request.push_str(request_line);
    request.push_str("\r\n");
    // The relay handles exactly one plain-HTTP request. Keep-alive would make
    // the client send the next request in absolute form down the same socket,
    // which the origin server rejects. Closing after the response makes the
    // client reconnect and pass through this rewrite again.
    for line in headers.split("\r\n").filter(|line| {
        let lower = line.to_ascii_lowercase();
        !line.is_empty()
            && !lower.starts_with("connection:")
            && !lower.starts_with("proxy-connection:")
    }) {
        request.push_str(line);
        request.push_str("\r\n");
    }
    request.push_str("Connection: close\r\n\r\n");
    if upstream.write_all(request.as_bytes()).await.is_err() {
        return;
    }
    if !rest.is_empty() && upstream.write_all(rest).await.is_err() {
        return;
    }
    let (client_read, client_write) = client.into_split();
    let (upstream_read, upstream_write) = upstream.into_split();
    tokio::join!(
        relay(client_read, upstream_write, false),
        relay(upstream_read, client_write, true),
    );
}

/// Reads the header block and any bytes already buffered after it.
async fn read_head(stream: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_head_end(&buf) {
            let head = String::from_utf8_lossy(&buf[..pos]).to_string();
            return Some((head, buf[pos + 4..].to_vec()));
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
    }
}

fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn parse_connect(line: &str) -> Option<(String, u16)> {
    let mut parts = line.split_whitespace();
    if !parts.next()?.eq_ignore_ascii_case("CONNECT") {
        return None;
    }
    let authority = parts.next()?;
    let (host, port) = authority.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    if port == 0 || host.is_empty() {
        return None;
    }
    let host = host.trim_start_matches('[').trim_end_matches(']');
    Some((host.to_string(), port))
}

/// Parses `GET http://host[:port]/path HTTP/1.1` into a connect target and an
/// origin-form request line. `None` for CONNECT, HTTPS and origin-form targets.
fn parse_http_forward(line: &str) -> Option<(String, u16, String)> {
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    if method.eq_ignore_ascii_case("CONNECT") {
        return None;
    }
    let target = parts.next()?;
    let version = parts.next().unwrap_or("HTTP/1.1");
    let rest = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("HTTP://"))?;
    let split = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(split);
    let path = if path.starts_with('/') {
        path.to_string()
    } else if path.starts_with('?') {
        format!("/{path}")
    } else {
        "/".to_string()
    };
    let (host, port) = split_authority(authority, 80)?;
    Some((host, port, format!("{method} {path} {version}")))
}

/// Splits `host`, `host:port` or `[v6]:port` into a connect target.
fn split_authority(authority: &str, default_port: u16) -> Option<(String, u16)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(port) => port.parse().ok()?,
            None => default_port,
        };
        return (port != 0 && !host.is_empty()).then(|| (host.to_string(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => {
            let port = port.parse().ok()?;
            (port != 0 && !host.is_empty()).then(|| (host.to_string(), port))
        }
        Some(_) => None,
        None => {
            (default_port != 0 && !authority.is_empty())
                .then(|| (authority.to_string(), default_port))
        }
    }
}

/// Copies one direction, pacing the payload when `capped` is set.
async fn relay(mut reader: OwnedReadHalf, mut writer: OwnedWriteHalf, capped: bool) {
    let mut buf = vec![0u8; READ_CHUNK];
    loop {
        let n = match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        if capped {
            let wait = BUCKET
                .lock()
                .map(|mut bucket| bucket.reserve(n))
                .unwrap_or(Duration::ZERO);
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
        }
        if writer.write_all(&buf[..n]).await.is_err() {
            return;
        }
    }
    let _ = writer.shutdown().await;
}

/// One token bucket shared by every tunnel, so N workers still add up to one cap.
struct Bucket {
    /// Bytes per second; 0 = unlimited.
    rate: f64,
    tokens: f64,
    burst: f64,
    last: Option<Instant>,
}

impl Bucket {
    const fn new() -> Self {
        Self {
            rate: 0.0,
            tokens: 0.0,
            burst: 0.0,
            last: None,
        }
    }

    fn configure(&mut self, bps: u64) {
        self.rate = bps as f64;
        self.burst = (self.rate * 0.2).clamp(16_384.0, 1_048_576.0);
        self.tokens = self.tokens.clamp(0.0, self.burst);
        self.last = None;
    }

    fn reserve(&mut self, n: usize) -> Duration {
        self.reserve_at(Instant::now(), n)
    }

    /// Pays for `n` bytes and reports how long the caller must wait first.
    fn reserve_at(&mut self, now: Instant, n: usize) -> Duration {
        if self.rate <= 0.0 {
            return Duration::ZERO;
        }
        let elapsed = self
            .last
            .map(|last| now.saturating_duration_since(last).as_secs_f64())
            .unwrap_or(0.0);
        self.last = Some(now);
        self.tokens = (self.tokens + elapsed * self.rate).min(self.burst);
        self.tokens -= n as f64;
        if self.tokens >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-self.tokens / self.rate)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_connect_authority() {
        assert_eq!(
            parse_connect("CONNECT launcher-public-service-prod06.ol.epicgames.com:443 HTTP/1.1"),
            Some(("launcher-public-service-prod06.ol.epicgames.com".into(), 443))
        );
        assert_eq!(
            parse_connect("connect [::1]:8080 HTTP/1.0"),
            Some(("::1".into(), 8080))
        );
    }

    #[test]
    fn rejects_plain_requests() {
        assert_eq!(parse_connect("GET http://example.com/ HTTP/1.1"), None);
        assert_eq!(parse_connect("CONNECT example.com HTTP/1.1"), None);
        assert_eq!(parse_connect("CONNECT example.com:0 HTTP/1.1"), None);
        assert_eq!(parse_connect(""), None);
    }

    #[test]
    fn rewrites_an_absolute_http_request() {
        assert_eq!(
            parse_http_forward("GET http://example.com/a?b=1 HTTP/1.1"),
            Some(("example.com".into(), 80, "GET /a?b=1 HTTP/1.1".into()))
        );
        assert_eq!(
            parse_http_forward("GET http://example.com:8080 HTTP/1.0"),
            Some(("example.com".into(), 8080, "GET / HTTP/1.0".into()))
        );
        assert_eq!(
            parse_http_forward("GET http://example.com?q=1 HTTP/1.1"),
            Some(("example.com".into(), 80, "GET /?q=1 HTTP/1.1".into()))
        );
        assert_eq!(
            parse_http_forward("GET http://[::1]:8080/x HTTP/1.1"),
            Some(("::1".into(), 8080, "GET /x HTTP/1.1".into()))
        );
        assert_eq!(parse_http_forward("GET https://example.com/ HTTP/1.1"), None);
        assert_eq!(
            parse_http_forward("CONNECT example.com:443 HTTP/1.1"),
            None
        );
        assert_eq!(parse_http_forward("GET /rooted HTTP/1.1"), None);
    }

    #[test]
    fn finds_the_header_end() {
        assert_eq!(find_head_end(b"CONNECT a:1\r\nHost: a\r\n\r\nrest"), Some(20));
        assert_eq!(find_head_end(b"CONNECT a:1\r\nHost: a\r\n"), None);
    }

    #[test]
    fn the_bucket_paces_once_the_burst_is_gone() {
        let now = Instant::now();
        let mut bucket = Bucket {
            rate: 1_000.0,
            tokens: 1_000.0,
            burst: 1_000.0,
            last: Some(now),
        };
        assert_eq!(bucket.reserve_at(now, 500), Duration::ZERO);
        let wait = bucket.reserve_at(now, 1_000);
        assert!((wait.as_secs_f64() - 0.5).abs() < 0.01);
        // Refill is time-based: one second later the debt is gone.
        let wait = bucket.reserve_at(now + Duration::from_secs(1), 500);
        assert_eq!(wait, Duration::ZERO);
    }

    #[test]
    fn an_empty_rate_never_waits() {
        let mut bucket = Bucket::new();
        bucket.configure(0);
        assert_eq!(bucket.reserve(64 * 1024), Duration::ZERO);
    }

    #[test]
    fn a_tiny_cap_is_raised_to_the_timeout_safe_floor() {
        assert_eq!(bps_for_rate(0.0), 0);
        assert_eq!(bps_for_rate(-1.0), 0);
        assert_eq!(bps_for_rate(f64::NAN), 0);
        // Below 0.1 Mbit/s one 16 KiB relay chunk would outlive legendary's
        // 10 second read timeout.
        assert_eq!(bps_for_rate(0.01), 12_500);
        assert_eq!(bps_for_rate(8.0), 1_000_000);
    }

    #[tokio::test]
    async fn tunnels_a_connect_request_and_caps_the_download() {
        use tokio::net::TcpListener as TokioListener;

        // A sink that answers every tunnel with 128 KiB.
        let sink = TokioListener::bind(("127.0.0.1", 0)).await.unwrap();
        let sink_addr = sink.local_addr().unwrap();
        let sink_task = tokio::spawn(async move {
            let (mut stream, _) = sink.accept().await.unwrap();
            stream.write_all(&vec![7u8; 128 * 1024]).await.unwrap();
            let _ = stream.shutdown().await;
        });

        let proxy = TokioListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_addr = proxy.local_addr().unwrap();
        let proxy_task = tokio::spawn(serve(proxy));

        set_rate(1.0); // 125 KiB/s
        let started = Instant::now();
        let mut client = TcpStream::connect(proxy_addr).await.unwrap();
        let request = format!("CONNECT {sink_addr} HTTP/1.1\r\nHost: {sink_addr}\r\n\r\n");
        client.write_all(request.as_bytes()).await.unwrap();

        let mut head = Vec::new();
        let mut byte = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            assert_eq!(client.read(&mut byte).await.unwrap(), 1);
            head.push(byte[0]);
        }
        assert!(head.starts_with(b"HTTP/1.1 200"), "{head:?}");

        let mut body = Vec::new();
        client.read_to_end(&mut body).await.unwrap();
        let elapsed = started.elapsed();
        assert_eq!(body.len(), 128 * 1024);
        // 128 KiB at 125 KiB/s minus the burst; a loose floor keeps this stable
        // on slow CI without letting an unthrottled tunnel pass.
        assert!(elapsed >= Duration::from_millis(600), "elapsed {elapsed:?}");

        set_rate(0.0);
        proxy_task.abort();
        sink_task.abort();
    }

    #[tokio::test]
    async fn forwards_a_plain_http_request() {
        use tokio::net::TcpListener as TokioListener;

        let server = TokioListener::bind(("127.0.0.1", 0)).await.unwrap();
        let server_addr = server.local_addr().unwrap();
        let server_task = tokio::spawn(async move {
            let (mut stream, _) = server.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let n = stream.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                request.extend_from_slice(&chunk[..n]);
            }
            let text = String::from_utf8_lossy(&request);
            assert!(text.starts_with("GET /hello HTTP/1.1\r\n"), "{text:?}");
            assert!(
                text.to_ascii_lowercase().contains("connection: close"),
                "{text:?}"
            );
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello",
                )
                .await
                .unwrap();
            let _ = stream.shutdown().await;
        });

        let proxy = TokioListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_addr = proxy.local_addr().unwrap();
        let proxy_task = tokio::spawn(serve(proxy));

        let mut client = TcpStream::connect(proxy_addr).await.unwrap();
        let request = format!(
            "GET http://{server_addr}/hello HTTP/1.1\r\nHost: {server_addr}\r\nConnection: close\r\n\r\n"
        );
        client.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        let text = String::from_utf8_lossy(&response);
        assert!(text.starts_with("HTTP/1.1 200"), "{text:?}");
        assert!(text.ends_with("hello"), "{text:?}");

        server_task.await.unwrap();
        proxy_task.abort();
    }
}
