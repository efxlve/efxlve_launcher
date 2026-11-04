//! The Demux socket: TLS framing plus the ownership/download service calls.
//!
//! Demux is a length-prefixed protobuf protocol: every message is a 4-byte
//! big-endian length followed by an `Upstream` (client to server) or
//! `Downstream` (server to client). Service traffic rides in `Push.data`
//! messages whose payload is itself length-prefixed.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

use super::codec;

const HOST: &str = "dmx.upc.ubisoft.com";
const PORT: u16 = 443;

/// Ubisoft Connect launcher build reported in the mandatory first frame.
///
/// The server answers a stale build with `ClientOutdatedPush` and drops the
/// socket. The value tracks the 4th component of the installed launcher build;
/// `EFXLVE_UBI_DEMUX_VERSION` overrides it without a rebuild while the client
/// rolls forward.
const DEFAULT_API_VERSION: u32 = 13247;

fn api_version() -> u32 {
    std::env::var("EFXLVE_UBI_DEMUX_VERSION")
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(DEFAULT_API_VERSION)
}

pub(crate) struct Demux {
    tls: TlsStream<TcpStream>,
    next_request_id: u32,
}

impl Demux {
    /// Connect, report the client build, and authenticate with a `ubi_v1`
    /// ticket. The caller keeps the ticket because reconnects reuse it.
    pub(crate) async fn connect(ticket: &str) -> Result<Self, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();

        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let connector = TlsConnector::from(Arc::new(config));

        let tcp = TcpStream::connect((HOST, PORT))
            .await
            .map_err(|e| format!("connecting to {HOST}:{PORT}: {e}"))?;
        let name = rustls::pki_types::ServerName::try_from(HOST)
            .map_err(|e| format!("invalid Demux server name: {e}"))?
            .to_owned();
        let tls = connector
            .connect(name, tcp)
            .await
            .map_err(|e| format!("Demux TLS handshake: {e}"))?;

        let mut demux = Self {
            tls,
            next_request_id: 1,
        };
        // The server names the current protocol build; announcing a stale one
        // can make a service ignore requests while ownership still answers.
        let version = match tokio::time::timeout(
            Duration::from_secs(5),
            demux.patch_version(),
        )
        .await
        {
            Ok(Ok(version)) if version > 0 => version,
            _ => api_version(),
        };
        if std::env::var_os("EFXLVE_UBI_DEBUG_DEMUX").is_some() {
            eprintln!("[demux] announcing client version {version}");
        }
        demux.write(&codec::client_version_push(version)).await?;
        demux.authenticate(ticket).await?;
        Ok(demux)
    }

    async fn patch_version(&mut self) -> Result<u32, String> {
        let id = self.next_id();
        self.write(&codec::patch_info_request(id)).await?;
        let response = self.response(id).await?;
        response
            .patch_version
            .ok_or_else(|| "Demux returned no patch version".to_string())
    }

    fn next_id(&mut self) -> u32 {
        let id = self.next_request_id;
        self.next_request_id = self.next_request_id.wrapping_add(1).max(1);
        id
    }

    async fn write(&mut self, message: &[u8]) -> Result<(), String> {
        let len = u32::try_from(message.len()).map_err(|_| "Demux frame too large".to_string())?;
        self.tls
            .write_all(&len.to_be_bytes())
            .await
            .map_err(|e| format!("writing Demux frame length: {e}"))?;
        self.tls
            .write_all(message)
            .await
            .map_err(|e| format!("writing Demux frame: {e}"))?;
        self.tls
            .flush()
            .await
            .map_err(|e| format!("flushing Demux frame: {e}"))
    }

    async fn read(&mut self) -> Result<codec::Downstream, String> {
        let fut = async {
            let mut len = [0u8; 4];
            self.tls
                .read_exact(&mut len)
                .await
                .map_err(|e| format!("reading Demux frame length: {e}"))?;
            let len = u32::from_be_bytes(len) as usize;
            if len > 64 * 1024 * 1024 {
                return Err(format!("Demux frame is {len} bytes; refusing it"));
            }
            let mut body = vec![0u8; len];
            self.tls
                .read_exact(&mut body)
                .await
                .map_err(|e| format!("reading Demux frame body: {e}"))?;
            Ok(codec::parse_downstream(&body))
        };
        match tokio::time::timeout(Duration::from_secs(20), fut).await {
            Ok(result) => result,
            Err(_) => Err("timed out waiting for a Demux response".to_string()),
        }
    }

    async fn authenticate(&mut self, ticket: &str) -> Result<(), String> {
        let id = self.next_id();
        self.write(&codec::authenticate_request(id, ticket)).await?;
        let response = self.response(id).await?;
        let auth = response
            .auth
            .ok_or_else(|| "Demux returned no authenticate_rsp".to_string())?;
        if !auth.success {
            return Err(format!(
                "Demux rejected the ticket (expired={}, banned={})",
                auth.expired, auth.banned
            ));
        }
        Ok(())
    }

    async fn response(&mut self, request_id: u32) -> Result<codec::Rsp, String> {
        for _ in 0..64 {
            let downstream = self.read().await?;
            if let Some(push) = &downstream.push {
                if push.client_outdated {
                    return Err(
                        "Demux says this client build is outdated; set EFXLVE_UBI_DEMUX_VERSION"
                            .to_string(),
                    );
                }
            }
            if let Some(response) = downstream.response {
                if response.request_id == request_id {
                    return Ok(response);
                }
            }
        }
        Err(format!("no Demux response for request {request_id}"))
    }

    pub(crate) async fn open_connection(&mut self, service: &str) -> Result<u32, String> {
        let id = self.next_id();
        self.write(&codec::open_connection_request(id, service)).await?;
        let response = self.response(id).await?;
        let open = response
            .open
            .ok_or_else(|| format!("Demux returned no open_connection_rsp for {service}"))?;
        if !open.success {
            return Err(format!("Demux refused a connection to {service}"));
        }
        Ok(open.connection_id)
    }

    async fn write_service(&mut self, connection_id: u32, payload: &[u8]) -> Result<(), String> {
        let mut framed = Vec::with_capacity(payload.len() + 4);
        framed.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        framed.extend_from_slice(payload);
        self.write(&codec::data_push(connection_id, &framed)).await
    }

    /// Send one service payload and return the matching payload back.
    pub(crate) async fn service_call(
        &mut self,
        connection_id: u32,
        payload: &[u8],
    ) -> Result<Vec<u8>, String> {
        self.write_service(connection_id, payload).await?;

        for _ in 0..64 {
            let downstream = self.read().await?;
            if let Some(push) = downstream.push {
                if push.client_outdated {
                    return Err(
                        "Demux says this client build is outdated; set EFXLVE_UBI_DEMUX_VERSION"
                            .to_string(),
                    );
                }
                if push.closed_connection == Some(connection_id) {
                    return Err(format!(
                        "Ubisoft closed service connection {connection_id} (code {})",
                        push.close_code
                    ));
                }
                if let Some(data) = push.data {
                    if data.connection_id == connection_id {
                        let raw = if data.data.len() >= 4 {
                            &data.data[4..]
                        } else {
                            &data.data
                        };
                        return Ok(raw.to_vec());
                    }
                }
            }
        }
        Err(format!("no Demux service response on connection {connection_id}"))
    }

    async fn ownership_connection(&mut self) -> Result<u32, String> {
        self.open_connection("ownership_service").await
    }

    async fn ownership_initialize(&mut self, connection_id: u32) -> Result<Vec<u8>, String> {
        self.service_call(connection_id, &codec::ownership_initialize_request(1))
            .await
    }

    /// The account's owned products, with the embedded configuration blob.
    pub(crate) async fn owned_games(&mut self) -> Result<Vec<codec::OwnedGame>, String> {
        let connection_id = self.ownership_connection().await?;
        let payload = self.ownership_initialize(connection_id).await?;
        let (success, games) = codec::parse_initialize_rsp(&payload);
        if !success {
            return Err("ownership_service refused the initialize request".to_string());
        }
        Ok(games)
    }

    /// Resolve manifest ids for products whose ownership row omitted them.
    pub(crate) async fn latest_manifests(
        &mut self,
        product_ids: &[u32],
    ) -> Result<HashMap<u32, String>, String> {
        let mut out = HashMap::new();
        if product_ids.is_empty() {
            return Ok(out);
        }
        let connection_id = self.ownership_connection().await?;
        self.ownership_initialize(connection_id).await?;
        let payload = self
            .service_call(
                connection_id,
                &codec::ownership_manifests_request(2, product_ids),
            )
            .await?;
        for (product_id, manifest) in codec::parse_manifests_rsp(&payload) {
            out.insert(product_id, manifest);
        }
        Ok(out)
    }

    pub(crate) async fn ownership_token(&mut self, product_id: u32) -> Result<String, String> {
        let connection_id = self.ownership_connection().await?;
        self.ownership_initialize(connection_id).await?;
        let payload = self
            .service_call(
                connection_id,
                &codec::ownership_token_request(2, product_id),
            )
            .await?;
        codec::parse_ownership_token(&payload)
            .ok_or_else(|| format!("no ownership token for product {product_id}"))
    }

    /// The real `uplay_pc` ticket the game's DRM expects, when the account still
    /// owns the product. A missing ticket is not fatal for offline single-player.
    pub(crate) async fn uplay_ticket(&mut self, uplay_id: u32) -> Result<Option<String>, String> {
        let connection_id = self.ownership_connection().await?;
        self.ownership_initialize(connection_id).await?;
        let payload = self
            .service_call(connection_id, &codec::uplay_ticket_request(2, uplay_id))
            .await?;
        Ok(codec::parse_uplay_ticket(&payload))
    }

    /// Ask `cloudsave_service` for signed S3 URLs for one or more save items.
    /// The request carries the ownership token, not the account ticket.
    pub(crate) async fn cloudsave_urls(
        &mut self,
        ownership_token: &str,
        uplay_id: u32,
        items: &[String],
    ) -> Result<Vec<codec::CloudsaveUrl>, String> {
        let connection_id = self.open_connection("cloudsave_service").await?;
        let payload = self
            .service_call(
                connection_id,
                &codec::cloudsave_url_request(
                    1,
                    ownership_token,
                    uplay_id,
                    codec::CLOUDSAVE_GET,
                    items,
                ),
            )
            .await?;
        let (status, urls) = codec::parse_cloudsave_urls(&payload);
        match status {
            1 => {}
            3 => return Err("Ubisoft denied access to this cloud save".to_string()),
            2 => return Err("Ubisoft could not open this cloud save".to_string()),
            _ if urls.is_empty() => {
                return Err("Ubisoft returned no cloud save URLs".to_string());
            }
            _ => {}
        }
        if urls.is_empty() {
            return Err("Ubisoft returned no cloud save URLs".to_string());
        }
        Ok(urls)
    }

    /// Open the download service for an ownership token and sign relative CDN
    /// paths into full URLs.
    pub(crate) async fn download_service(
        &mut self,
        ownership_token: &str,
    ) -> Result<DownloadService, String> {
        let connection_id = self.open_connection("download_service").await?;
        let mut service = DownloadService {
            connection_id,
            next_request_id: 1,
        };
        let request_id = service.next_id();
        let _ = self
            .service_call(
                connection_id,
                &codec::download_initialize_request(request_id, ownership_token),
            )
            .await?;
        // An empty initialize response is what some builds return; the URL call
        // is the real proof that the token was accepted.
        Ok(service)
    }
}

/// A held-open `download_service` connection with its own request counter.
pub(crate) struct DownloadService {
    connection_id: u32,
    next_request_id: u32,
}

impl DownloadService {
    fn next_id(&mut self) -> u32 {
        let id = self.next_request_id;
        self.next_request_id = self.next_request_id.wrapping_add(1).max(1);
        id
    }

    pub(crate) async fn sign(
        &mut self,
        demux: &mut Demux,
        product_id: u32,
        paths: &[String],
    ) -> Result<Vec<String>, String> {
        let request_id = self.next_id();
        let payload = demux
            .service_call(
                self.connection_id,
                &codec::download_urls_request(request_id, product_id, paths),
            )
            .await?;
        let urls = codec::parse_download_urls(&payload);
        if urls.is_empty() {
            return Err("download_service returned no signed URLs".to_string());
        }
        Ok(urls)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_version_can_be_overridden() {
        std::env::set_var("EFXLVE_UBI_DEMUX_VERSION", "999");
        assert_eq!(api_version(), 999);
        std::env::remove_var("EFXLVE_UBI_DEMUX_VERSION");
        assert_eq!(api_version(), DEFAULT_API_VERSION);
    }

    #[tokio::test]
    #[ignore = "opens a live TLS socket to Ubisoft; no account needed"]
    async fn live_demux_rejects_a_bad_ticket() {
        let error = Demux::connect("not-a-real-ticket")
            .await
            .err()
            .expect("a fake ticket must not authenticate");
        println!("{error}");
        assert!(error.contains("rejected") || error.contains("outdated"), "{error}");
    }
}
