//! A real bandwidth cap for Epic downloads.
//!
//! legendary has no rate-limit flag, but its download workers use `requests`,
//! which honours `HTTPS_PROXY`. The install child is pointed at this loopback
//! proxy, and one shared token bucket paces every CONNECT tunnel it opens.
//! Only the download direction is capped; request bytes are tiny.
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
pub fn set_rate(mbps: f64) {
    let bps = (mbps.max(0.0) * BPS_PER_MBPS).round() as u64;
    RATE_BPS.store(bps, Ordering::Relaxed);
    if let Ok(mut bucket) = BUCKET.lock() {
        bucket.configure(bps);
    }
}

/// The proxy URL the installer should use, or `None` while no cap is set.
pub fn proxy_url() -> Option<String> {
    if RATE_BPS.load(Ordering::Relaxed) == 0 {
        return None;
    }
    let port = PORT.load(Ordering::Relaxed);
    (port != 0).then(|| format!("http://127.0.0.1:{port}"))
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
    let Some((first_line, rest)) = read_head(&mut client).await else {
        return;
    };
    let Some((host, port)) = parse_connect(&first_line) else {
        let _ = client
            .write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n")
            .await;
        return;
    };
    let Ok(mut upstream) = TcpStream::connect((host.as_str(), port)).await else {
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
    if !rest.is_empty() && upstream.write_all(&rest).await.is_err() {
        return;
    }
    let (client_read, client_write) = client.into_split();
    let (upstream_read, upstream_write) = upstream.into_split();
    tokio::join!(
        relay(client_read, upstream_write, false),
        relay(upstream_read, client_write, true),
    );
}

/// Reads the request line and any bytes already buffered after the header.
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
            let head = String::from_utf8_lossy(&buf[..pos]);
            let first = head.lines().next()?.to_string();
            return Some((first, buf[pos + 4..].to_vec()));
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
}
