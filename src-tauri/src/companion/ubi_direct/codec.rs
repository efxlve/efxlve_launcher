//! Protobuf messages for Ubisoft's Demux wire and its ownership/download
//! services.
//!
//! Field numbers come from the schemas published by YoobieRE and used by
//! Optima (GPL-3.0-or-later). Only the subset the launcher needs is encoded
//! here, so a service change shows up as an empty field rather than a compile
//! error in generated code.

use crate::companion::proto::{
    for_each_field, push_bool, push_bytes, push_packed_u32, push_string, push_varint_field,
};

pub(crate) const CLIENT_ID: &str = "uplay_pc";

/// `mg.protocol.demux.Token` with the `ubi_v1` ticket in field 3.
fn token(ticket: &str) -> Vec<u8> {
    let mut out = Vec::new();
    push_string(&mut out, 3, ticket);
    out
}

/// A `Req` wrapped in `Upstream`.
fn request(request_id: u32, field: u32, body: &[u8]) -> Vec<u8> {
    let mut req = Vec::new();
    push_varint_field(&mut req, 1, u64::from(request_id));
    push_bytes(&mut req, field, body);
    let mut upstream = Vec::new();
    push_bytes(&mut upstream, 1, &req);
    upstream
}

/// A `Push` wrapped in `Upstream`.
fn push(field: u32, body: &[u8]) -> Vec<u8> {
    let mut p = Vec::new();
    push_bytes(&mut p, field, body);
    let mut upstream = Vec::new();
    push_bytes(&mut upstream, 2, &p);
    upstream
}

pub(crate) fn authenticate_request(request_id: u32, ticket: &str) -> Vec<u8> {
    let token = token(ticket);
    let mut auth = Vec::new();
    push_bytes(&mut auth, 1, &token);
    push_string(&mut auth, 2, CLIENT_ID);
    push_bool(&mut auth, 4, false);
    request(request_id, 2, &auth)
}

pub(crate) fn open_connection_request(request_id: u32, service: &str) -> Vec<u8> {
    let mut open = Vec::new();
    push_string(&mut open, 2, service);
    request(request_id, 3, &open)
}

pub(crate) fn client_version_push(version: u32) -> Vec<u8> {
    let mut body = Vec::new();
    push_varint_field(&mut body, 1, u64::from(version));
    push(4, &body)
}

pub(crate) fn data_push(connection_id: u32, data: &[u8]) -> Vec<u8> {
    let mut message = Vec::new();
    push_varint_field(&mut message, 1, u64::from(connection_id));
    push_bytes(&mut message, 2, data);
    push(1, &message)
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct AuthRsp {
    pub success: bool,
    pub expired: bool,
    pub banned: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct OpenRsp {
    pub connection_id: u32,
    pub success: bool,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Rsp {
    pub request_id: u32,
    pub auth: Option<AuthRsp>,
    pub open: Option<OpenRsp>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct DataMessage {
    pub connection_id: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Push {
    pub data: Option<DataMessage>,
    pub client_outdated: bool,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Downstream {
    pub response: Option<Rsp>,
    pub push: Option<Push>,
}

fn parse_auth_rsp(payload: &[u8]) -> AuthRsp {
    let mut out = AuthRsp::default();
    for_each_field(
        payload,
        |_, _| {},
        |field, value| match field {
            1 => out.success = value != 0,
            2 => out.expired = value != 0,
            3 => out.banned = value != 0,
            _ => {}
        },
    );
    out
}

fn parse_open_rsp(payload: &[u8]) -> OpenRsp {
    let mut out = OpenRsp::default();
    for_each_field(
        payload,
        |_, _| {},
        |field, value| match field {
            1 => out.connection_id = value as u32,
            2 => out.success = value != 0,
            _ => {}
        },
    );
    out
}

fn parse_rsp(payload: &[u8]) -> Rsp {
    let mut out = Rsp::default();
    for_each_field(
        payload,
        |field, bytes| match field {
            2 => out.auth = Some(parse_auth_rsp(bytes)),
            3 => out.open = Some(parse_open_rsp(bytes)),
            _ => {}
        },
        |field, value| {
            if field == 1 {
                out.request_id = value as u32;
            }
        },
    );
    out
}

fn parse_data(payload: &[u8]) -> DataMessage {
    let mut out = DataMessage::default();
    for_each_field(
        payload,
        |field, bytes| {
            if field == 2 {
                out.data = bytes.to_vec();
            }
        },
        |field, value| {
            if field == 1 {
                out.connection_id = value as u32;
            }
        },
    );
    out
}

fn parse_push_message(payload: &[u8]) -> Push {
    let mut out = Push::default();
    for_each_field(
        payload,
        |field, bytes| match field {
            1 => out.data = Some(parse_data(bytes)),
            5 => out.client_outdated = true,
            _ => {}
        },
        |_, _| {},
    );
    out
}

pub(crate) fn parse_downstream(payload: &[u8]) -> Downstream {
    let mut out = Downstream::default();
    for_each_field(
        payload,
        |field, bytes| match field {
            1 => out.response = Some(parse_rsp(bytes)),
            2 => out.push = Some(parse_push_message(bytes)),
            _ => {}
        },
        |_, _| {},
    );
    out
}

/// One owned product from `ownership_service.InitializeRsp`.
#[derive(Debug, Clone, Default)]
pub(crate) struct OwnedGame {
    pub product_id: u32,
    pub uplay_id: u32,
    pub product_type: u32,
    pub owned: bool,
    pub configuration: String,
    pub latest_manifest: String,
}

fn parse_owned_game(payload: &[u8]) -> OwnedGame {
    let mut out = OwnedGame::default();
    for_each_field(
        payload,
        |field, bytes| match field {
            17 => out.configuration = String::from_utf8_lossy(bytes).to_string(),
            21 => out.latest_manifest = String::from_utf8_lossy(bytes).to_string(),
            _ => {}
        },
        |field, value| match field {
            1 => out.product_id = value as u32,
            8 => out.product_type = value as u32,
            19 => out.uplay_id = value as u32,
            20 => out.owned = value != 0,
            _ => {}
        },
    );
    out
}

fn parse_owned_games(payload: &[u8]) -> Vec<OwnedGame> {
    let mut out = Vec::new();
    for_each_field(
        payload,
        |field, bytes| {
            if field == 1 {
                out.push(parse_owned_game(bytes));
            }
        },
        |_, _| {},
    );
    out
}

pub(crate) fn ownership_initialize_request(request_id: u32) -> Vec<u8> {
    let mut init = Vec::new();
    push_bool(&mut init, 2, true);
    // The service rejects an initialize that does not name a protocol version.
    push_varint_field(&mut init, 3, 7);
    let mut req = Vec::new();
    push_varint_field(&mut req, 1, u64::from(request_id));
    push_bytes(&mut req, 2, &init);
    let mut upstream = Vec::new();
    push_bytes(&mut upstream, 1, &req);
    upstream
}

/// Unwrap `ownership.Downstream` -> `Rsp` -> the message in `field`.
fn service_body(payload: &[u8], field: u32) -> Vec<u8> {
    let mut rsp = Vec::new();
    for_each_field(
        payload,
        |outer, bytes| {
            if outer == 1 {
                rsp = bytes.to_vec();
            }
        },
        |_, _| {},
    );
    let mut body = Vec::new();
    for_each_field(
        &rsp,
        |inner, bytes| {
            if inner == field {
                body = bytes.to_vec();
            }
        },
        |_, _| {},
    );
    body
}

pub(crate) fn parse_initialize_rsp(payload: &[u8]) -> (bool, Vec<OwnedGame>) {
    let body = service_body(payload, 2);
    let mut success = false;
    let mut games = Vec::new();
    for_each_field(
        &body,
        |field, bytes| {
            if field == 2 {
                games = parse_owned_games(bytes);
            }
        },
        |field, value| {
            if field == 1 {
                success = value != 0;
            }
        },
    );
    (success, games)
}

pub(crate) fn ownership_manifests_request(request_id: u32, product_ids: &[u32]) -> Vec<u8> {
    let mut asked = Vec::new();
    push_packed_u32(&mut asked, 1, product_ids);
    let mut req = Vec::new();
    push_varint_field(&mut req, 1, u64::from(request_id));
    push_bytes(&mut req, 10, &asked);
    let mut upstream = Vec::new();
    push_bytes(&mut upstream, 1, &req);
    upstream
}

pub(crate) fn parse_manifests_rsp(payload: &[u8]) -> Vec<(u32, String)> {
    let body = service_body(payload, 10);
    let mut out = Vec::new();
    for_each_field(
        &body,
        |field, bytes| {
            if field != 2 {
                return;
            }
            let mut product_id = 0u32;
            let mut manifest = String::new();
            for_each_field(
                bytes,
                |inner, value| {
                    if inner == 3 {
                        manifest = String::from_utf8_lossy(value).to_string();
                    }
                },
                |inner, value| {
                    if inner == 2 {
                        product_id = value as u32;
                    }
                },
            );
            if product_id != 0 && !manifest.is_empty() {
                out.push((product_id, manifest));
            }
        },
        |_, _| {},
    );
    out
}

pub(crate) fn ownership_token_request(request_id: u32, product_id: u32) -> Vec<u8> {
    let mut body = Vec::new();
    push_varint_field(&mut body, 1, u64::from(product_id));
    let mut req = Vec::new();
    push_varint_field(&mut req, 1, u64::from(request_id));
    push_bytes(&mut req, 28, &body);
    let mut upstream = Vec::new();
    push_bytes(&mut upstream, 1, &req);
    upstream
}

pub(crate) fn parse_ownership_token(payload: &[u8]) -> Option<String> {
    let body = service_body(payload, 27);
    let mut success = false;
    let mut token = String::new();
    for_each_field(
        &body,
        |field, bytes| {
            if field == 2 {
                token = String::from_utf8_lossy(bytes).to_string();
            }
        },
        |field, value| {
            if field == 1 {
                success = value != 0;
            }
        },
    );
    (success && !token.is_empty()).then_some(token)
}

pub(crate) fn uplay_ticket_request(request_id: u32, uplay_id: u32) -> Vec<u8> {
    let mut body = Vec::new();
    push_varint_field(&mut body, 1, u64::from(uplay_id));
    let mut req = Vec::new();
    push_varint_field(&mut req, 1, u64::from(request_id));
    push_bytes(&mut req, 14, &body);
    let mut upstream = Vec::new();
    push_bytes(&mut upstream, 1, &req);
    upstream
}

pub(crate) fn parse_uplay_ticket(payload: &[u8]) -> Option<String> {
    let body = service_body(payload, 13);
    let mut success = false;
    let mut ticket = String::new();
    for_each_field(
        &body,
        |field, bytes| {
            if field == 2 {
                ticket = String::from_utf8_lossy(bytes).to_string();
            }
        },
        |field, value| {
            if field == 1 {
                success = value != 0;
            }
        },
    );
    (success && !ticket.is_empty()).then_some(ticket)
}

pub(crate) fn download_initialize_request(request_id: u32, ownership_token: &str) -> Vec<u8> {
    let mut init = Vec::new();
    push_string(&mut init, 5, ownership_token);
    let mut req = Vec::new();
    push_varint_field(&mut req, 1, u64::from(request_id));
    push_bytes(&mut req, 2, &init);
    let mut upstream = Vec::new();
    push_bytes(&mut upstream, 1, &req);
    upstream
}

pub(crate) fn download_urls_request(request_id: u32, product_id: u32, paths: &[String]) -> Vec<u8> {
    let mut one = Vec::new();
    push_varint_field(&mut one, 1, u64::from(product_id));
    for path in paths {
        push_string(&mut one, 2, path);
    }
    let mut url_req = Vec::new();
    push_bytes(&mut url_req, 1, &one);
    let mut req = Vec::new();
    push_varint_field(&mut req, 1, u64::from(request_id));
    push_bytes(&mut req, 3, &url_req);
    let mut upstream = Vec::new();
    push_bytes(&mut upstream, 1, &req);
    upstream
}

/// Pull the signed URLs out of `download_service.Downstream`.
pub(crate) fn parse_download_urls(payload: &[u8]) -> Vec<String> {
    let mut urls = Vec::new();
    for_each_field(
        payload,
        |field, rsp| {
            if field != 1 {
                return;
            }
            for_each_field(
                rsp,
                |inner, url_rsp| {
                    if inner != 3 {
                        return;
                    }
                    for_each_field(
                        url_rsp,
                        |url_field, url_response| {
                            if url_field != 1 {
                                return;
                            }
                            for_each_field(
                                url_response,
                                |download_field, download_urls| {
                                    if download_field != 2 {
                                        return;
                                    }
                                    for_each_field(
                                        download_urls,
                                        |url_field, url| {
                                            if url_field == 1 {
                                                urls.push(String::from_utf8_lossy(url).to_string());
                                            }
                                        },
                                        |_, _| {},
                                    );
                                },
                                |_, _| {},
                            );
                        },
                        |_, _| {},
                    );
                },
                |_, _| {},
            );
        },
        |_, _| {},
    );
    urls
}

/// Decode a packed or unpacked repeated uint32 field.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::proto::packed_u32;

    #[test]
    fn authenticate_request_carries_the_ticket_and_client_id() {
        let bytes = authenticate_request(7, "ticket-value");
        let mut request_id = 0u32;
        let mut ticket = String::new();
        let mut client = String::new();
        for_each_field(
            &bytes,
            |field, upstream| {
                if field != 1 {
                    return;
                }
                for_each_field(
                    upstream,
                    |inner, request| {
                        if inner != 2 {
                            return;
                        }
                        for_each_field(
                            request,
                            |auth_field, auth| {
                                if auth_field == 1 {
                                    for_each_field(
                                        auth,
                                        |token_field, token| {
                                            if token_field == 3 {
                                                ticket =
                                                    String::from_utf8_lossy(token).to_string();
                                            }
                                        },
                                        |_, _| {},
                                    );
                                } else if auth_field == 2 {
                                    client = String::from_utf8_lossy(auth).to_string();
                                }
                            },
                            |_, _| {},
                        );
                    },
                    |inner, value| {
                        if inner == 1 {
                            request_id = value as u32;
                        }
                    },
                );
            },
            |_, _| {},
        );
        assert_eq!(request_id, 7);
        assert_eq!(ticket, "ticket-value");
        assert_eq!(client, CLIENT_ID);
    }

    #[test]
    fn packed_product_ids_round_trip() {
        let ids = [12u32, 34, 56];
        let bytes = ownership_manifests_request(2, &ids);
        // The request nests Req field 10 -> packed field 1.
        let mut found = false;
        for_each_field(
            &bytes,
            |field, upstream| {
                if field != 1 {
                    return;
                }
                for_each_field(
                    upstream,
                    |inner, req| {
                        if inner != 10 {
                            return;
                        }
                        for_each_field(
                            req,
                            |packed_field, payload| {
                                if packed_field == 1 {
                                    assert_eq!(packed_u32(payload), ids);
                                    found = true;
                                }
                            },
                            |_, _| {},
                        );
                    },
                    |_, _| {},
                );
            },
            |_, _| {},
        );
        assert!(found);
    }

    #[test]
    fn owned_game_fields_are_read_from_the_service_schema() {
        let mut config = Vec::new();
        push_string(&mut config, 3, "root:\n  name: GAMENAME\n");
        let mut game = Vec::new();
        push_varint_field(&mut game, 1, 123);
        push_varint_field(&mut game, 8, 0);
        push_varint_field(&mut game, 19, 456);
        push_varint_field(&mut game, 20, 1);
        push_bytes(&mut game, 17, &config);
        push_string(&mut game, 21, "manifest-123");
        let mut owned = Vec::new();
        push_bytes(&mut owned, 1, &game);
        let mut init = Vec::new();
        push_bool(&mut init, 1, true);
        push_bytes(&mut init, 2, &owned);
        let mut rsp = Vec::new();
        push_bytes(&mut rsp, 2, &init);
        let mut downstream = Vec::new();
        push_bytes(&mut downstream, 1, &rsp);
        let (success, games) = parse_initialize_rsp(&downstream);
        assert!(success);
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].product_id, 123);
        assert_eq!(games[0].uplay_id, 456);
        assert!(games[0].owned);
        assert_eq!(games[0].latest_manifest, "manifest-123");
        assert!(games[0].configuration.contains("GAMENAME"));
    }
}
