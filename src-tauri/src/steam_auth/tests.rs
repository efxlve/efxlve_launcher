use std::path::PathBuf;

use base64::Engine;
use serde_json::Value;

use super::vault::dpapi;
use super::*;

fn begin_fixture() -> Value {
    serde_json::json!({
        "client_id": "12345678901234567890",
        "request_id": "q1w2e3r4t5==",
        "interval": 5.0,
        "steamid": "76561199140017878",
        "allowed_confirmations": [
            { "confirmation_type": 3, "associated_message": "" },
            { "confirmation_type": 4, "associated_message": "device" }
        ]
    })
}

#[test]
fn begin_response_maps_to_a_pending_login() {
    let pending = parse_begin_response("efxlve", true, &begin_fixture()).expect("pending");
    assert_eq!(pending.account_name, "efxlve");
    assert_eq!(pending.client_id, "12345678901234567890");
    assert_eq!(pending.steam_id, "76561199140017878");
    assert_eq!(pending.code_type(), GUARD_DEVICE_CODE);
    assert!(pending.needs_code());
    assert!(pending.needs_confirmation());
    assert!(pending.status().confirm, "the app approval stays available");
    assert_eq!(pending.status().state, "code");
}

#[test]
fn begin_response_rejects_incomplete_payloads() {
    assert!(parse_begin_response("x", true, &serde_json::json!({})).is_err());
    assert!(parse_begin_response("x", true, &serde_json::json!({ "client_id": "1" })).is_err());
}

#[test]
fn poll_reports_approval_with_the_refresh_token() {
    let pending = parse_begin_response("efxlve", true, &begin_fixture()).unwrap();
    let response = serde_json::json!({
        "refresh_token": "eyJhbGciOiJ",
        "access_token": "",
        "account_name": "efxlve"
    });
    match parse_poll_response(&response, &pending) {
        PollOutcome::Approved {
            refresh_token,
            account_name,
            ..
        } => {
            assert_eq!(refresh_token, "eyJhbGciOiJ");
            assert_eq!(account_name, "efxlve");
        }
        PollOutcome::Waiting { .. } => panic!("approved expected"),
    }

    let waiting = serde_json::json!({ "new_client_id": "42" });
    match parse_poll_response(&waiting, &pending) {
        PollOutcome::Waiting { new_client_id } => assert_eq!(new_client_id, "42"),
        PollOutcome::Approved { .. } => panic!("waiting expected"),
    }
}

#[test]
fn begin_request_encodes_the_expected_protobuf_fields() {
    let bytes = encode_begin_request("efxlve", "QUJD", "1700000000", true);
    // Tiny decoder: walk fields in order and collect (number, value).
    fn read_varint(data: &[u8], pos: &mut usize) -> u64 {
        let mut value = 0u64;
        let mut shift = 0;
        loop {
            let byte = data[*pos];
            *pos += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return value;
            }
            shift += 7;
        }
    }
    let mut pos = 0;
    let mut strings: Vec<(u64, String)> = Vec::new();
    let mut numbers: Vec<(u64, u64)> = Vec::new();
    let mut details: Option<Vec<u8>> = None;
    while pos < bytes.len() {
        let tag = read_varint(&bytes, &mut pos);
        let (field, wire) = (tag >> 3, tag & 7);
        if wire == 2 {
            let len = read_varint(&bytes, &mut pos) as usize;
            let value = bytes[pos..pos + len].to_vec();
            pos += len;
            if field == 9 {
                details = Some(value);
            } else {
                strings.push((field, String::from_utf8(value).unwrap()));
            }
        } else {
            numbers.push((field, read_varint(&bytes, &mut pos)));
        }
    }
    assert_eq!(strings[0], (2, "efxlve".to_string()));
    assert_eq!(strings[1], (3, "QUJD".to_string()));
    assert_eq!(strings[2], (8, WEBSITE_ID.to_string()));
    assert_eq!(numbers[0], (4, 1_700_000_000));
    assert_eq!(numbers[1], (5, 1));
    assert_eq!(numbers[2], (6, PLATFORM_TYPE_WEB as u64));
    assert_eq!(numbers[3], (7, 1));

    let details = details.expect("device_details");
    let mut expected = vec![0x0au8, DEVICE_NAME.len() as u8];
    expected.extend_from_slice(DEVICE_NAME.as_bytes());
    expected.push(0x10); // field 2, varint
    expected.push(PLATFORM_TYPE_WEB as u8);
    assert_eq!(details, expected);
}

#[test]
fn owned_games_payload_is_flattened() {
    let response = serde_json::json!({
        "game_count": 2,
        "games": [
            { "appid": 620, "name": "Portal 2", "playtime_forever": 90, "img_icon_url": "abc" },
            { "appid": 730, "name": "Counter-Strike 2", "playtime_2weeks": 12 }
        ]
    });
    let owned = parse_owned_games(&response);
    assert_eq!(owned.game_count, 2);
    assert_eq!(owned.games.len(), 2);
    assert_eq!(owned.games[0].app_id, "620");
    assert_eq!(owned.games[0].playtime_forever, 90);
    assert!(owned.games[0].icon_url.ends_with("/620/abc.jpg"));
    assert_eq!(owned.games[1].app_id, "730");
    assert_eq!(owned.games[1].playtime_two_weeks, 12);
    assert!(parse_owned_games(&serde_json::json!({})).games.is_empty());
}

#[test]
fn email_only_guard_has_no_app_approval() {
    let payload = serde_json::json!({
        "client_id": "1",
        "request_id": "AA==",
        "allowed_confirmations": [{ "confirmation_type": 2, "associated_message": "example.com" }]
    });
    let pending = parse_begin_response("x", false, &payload).expect("pending");
    assert_eq!(pending.status().state, "code");
    assert_eq!(pending.status().email_hint, "example.com");
    assert!(
        !pending.status().confirm,
        "no mobile confirmation was offered"
    );
}

#[test]
fn eresult_codes_become_translation_keys() {
    assert_eq!(eresult_error(5), "@t:steam.err.invalidPassword");
    assert_eq!(eresult_error(88), "@t:steam.err.guardInvalid");
    assert_eq!(eresult_error(84), "@t:steam.err.throttled");
    assert_eq!(eresult_error(101), "@t:steam.err.captcha");
    assert_eq!(eresult_error(9), "@t:steam.err.sessionNotFound");
    assert_eq!(eresult_error(999), "@t:steam.err.steam\u{1f}999");
}

#[test]
fn steam_login_secure_cookie_carries_the_web_access_token() {
    let cookie = "steamLoginSecure=76561199140017878%7C%7CeyJhbGciOiJub25lIn0.abc-123_456%3D%3D; Path=/; Secure; HttpOnly; SameSite=None";
    assert_eq!(
        cookie_access_token(cookie).as_deref(),
        Some("eyJhbGciOiJub25lIn0.abc-123_456==")
    );
    assert!(cookie_access_token("sessionid=abc").is_none());
    assert!(cookie_access_token("steamLoginSecure=7656119%7C%7C").is_none());
    assert_eq!(percent_decode("a%20b%7C%7Cc+d"), "a b||c+d");
    assert_eq!(percent_decode("%zz"), "%zz");
}

#[test]
fn finalize_payload_yields_the_community_transfer() {
    let payload = serde_json::json!({
        "steamID": "76561199140017878",
        "transfer_info": [
            { "url": "https://store.steampowered.com/login/settoken", "params": { "nonce": "n1", "auth": "a1" } },
            { "url": "https://steamcommunity.com/login/settoken", "params": { "nonce": "n2", "auth": "a2" } }
        ]
    });
    let (url, params) = settoken_transfer(&payload).expect("community transfer");
    assert!(url.contains("steamcommunity.com"));
    let mut sorted = params;
    sorted.sort();
    assert_eq!(
        sorted,
        vec![
            ("auth".to_string(), "a2".to_string()),
            ("nonce".to_string(), "n2".to_string())
        ]
    );
    assert!(settoken_transfer(&serde_json::json!({})).is_none());
}

#[test]
fn only_a_401_ends_the_steam_session() {
    assert!(super::session::status_ends_session(
        reqwest::StatusCode::UNAUTHORIZED
    ));
    for status in [
        reqwest::StatusCode::FORBIDDEN,
        reqwest::StatusCode::TOO_MANY_REQUESTS,
        reqwest::StatusCode::BAD_GATEWAY,
        reqwest::StatusCode::SERVICE_UNAVAILABLE,
    ] {
        assert!(
            !super::session::status_ends_session(status),
            "{status} must stay a network failure"
        );
    }
}

#[test]
fn auth_requests_encode_the_expected_wire_fields() {
    // Poll: field 1 varint client_id, field 2 length-delimited request_id.
    let poll = encode_poll_request("42", &[0xde, 0xad, 0xbe, 0xef]);
    assert_eq!(poll[0], 0x08);
    assert_eq!(poll[1], 42);
    assert_eq!(poll[2], 0x12);
    assert_eq!(poll[3], 4);
    assert_eq!(&poll[4..], &[0xde, 0xad, 0xbe, 0xef]);

    // Guard code: field 2 is fixed64, then the code and its type.
    let update = encode_guard_code_request("7", "76561199140017878", "ABC12", GUARD_DEVICE_CODE);
    assert_eq!(update[0], 0x08);
    assert_eq!(update[1], 7);
    assert_eq!(update[2], 0x11);
    assert_eq!(&update[3..11], &76561199140017878u64.to_le_bytes());
    assert_eq!(update[11], 0x1a);
    assert_eq!(update[12], 5);
    assert_eq!(&update[13..18], b"ABC12");
    assert_eq!(update[18], 0x20);
    assert_eq!(update[19], 3);

    // Generate: refresh token string, steamid fixed64.
    let generate = encode_generate_request("tok", "5");
    assert_eq!(generate[0], 0x0a);
    assert_eq!(generate[1], 3);
    assert_eq!(&generate[2..5], b"tok");
    assert_eq!(generate[5], 0x11);
    assert_eq!(&generate[6..14], &5u64.to_le_bytes());
}

#[test]
fn byte_fields_decode_from_base64() {
    let raw = [0x01u8, 0x02, 0x03];
    let encoded = base64::engine::general_purpose::STANDARD.encode(raw);
    assert_eq!(decode_base64_bytes(&encoded), raw);
    assert!(decode_base64_bytes("!!!not-base64!!!").is_empty());
}

#[test]
fn jwt_expiry_is_read_from_the_payload() {
    let payload = serde_json::json!({ "sub": "76561199140017878", "exp": 1_800_000_000u64 });
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&payload).unwrap());
    let token = format!("header.{encoded}.signature");
    assert_eq!(token_exp_secs(&token), 1_800_000_000);
    assert_eq!(token_exp_secs("not-a-jwt"), 0);
}

#[test]
fn rsa_encrypted_password_is_decryptable() {
    use rsa::traits::PublicKeyParts;
    use rsa::{Pkcs1v15Encrypt, RsaPrivateKey};

    let mut rng = rand::thread_rng();
    let private = RsaPrivateKey::new(&mut rng, 512).expect("test key");
    let public = private.to_public_key();
    let modulus = format!("{:x}", public.n());
    let exponent = format!("{:x}", public.e());

    let encoded = encrypt_password("hunter2", &modulus, &exponent).expect("encrypted");
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    let plain = private
        .decrypt(Pkcs1v15Encrypt, &ciphertext)
        .expect("decrypted");
    assert_eq!(String::from_utf8(plain).unwrap(), "hunter2");

    assert!(encrypt_password("x", "not-hex", "010001").is_err());
    assert!(encrypt_password("x", "0b", "0b").is_err());
}

#[cfg(windows)]
#[test]
fn dpapi_seals_and_opens_roundtrip() {
    let secret = b"refresh-token-value";
    let sealed = dpapi::protect(secret).expect("sealed");
    assert_ne!(sealed, secret);
    assert_eq!(dpapi::unprotect(&sealed).expect("opened"), secret);
    assert!(dpapi::unprotect(b"definitely not sealed").is_err());
}

#[test]
fn missing_session_is_not_signed_in() {
    // Pure parsing path: no disk, no network.
    let state = AuthState::default();
    assert!(state.session.is_none());
    assert!(state.pending.is_none());
}

/// Live probe: RSA key fetch + a dummy credential request. A wrong password
/// is expected (`eresult 5`), which proves the request shape is accepted.
/// Run: `cargo test live_steam_rsa_probe -- --ignored --nocapture`
#[test]
#[ignore]
fn live_steam_rsa_probe() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let client = http_client().unwrap();
        let (modulus, exponent, timestamp) = get_rsa_key(&client, "efxlve").await.unwrap();
        println!(
            "rsa modulus: {} chars, timestamp {timestamp}",
            modulus.len()
        );
        let encrypted = encrypt_password("definitely-wrong", &modulus, &exponent).unwrap();
        let request = encode_begin_request("efxlve", &encrypted, &timestamp, true);
        let form = vec![(
            "input_protobuf_encoded".to_string(),
            base64::engine::general_purpose::STANDARD.encode(request),
        )];
        let call = post_form(&client, "BeginAuthSessionViaCredentials", &form)
            .await
            .unwrap();
        println!(
            "begin eresult: {} ({})",
            call.eresult,
            eresult_error(call.eresult)
        );
        assert!(call.eresult != 1, "a wrong password must not succeed");

        // finalizelogin shape: a dummy refresh token must be rejected with a
        // structured JSON error, not a routing/parse failure.
        let finalize =
            finalize_web_login(&client, "not-a-real-refresh-token", "76561199140017878").await;
        println!("finalize result: {:?}", finalize);
        assert!(
            finalize.is_err(),
            "a dummy refresh token must not mint a token"
        );
    });
}

#[test]
fn vault_ids_must_be_steamid64_digits() {
    assert!(valid_steam_id("76561199140017878"));
    // Anything else could climb out of the vault directory once it is joined
    // into a file path, so the command boundary rejects it.
    assert!(!valid_steam_id("..\\..\\x"));
    assert!(!valid_steam_id("../x"));
    assert!(!valid_steam_id(""));
    assert!(!valid_steam_id("7656119914001787a"));
    assert!(!valid_steam_id(&"9".repeat(21)));
}

#[test]
fn vault_paths_stay_inside_the_accounts_directory() {
    let dir = std::env::temp_dir().join("efxlve_steam_vault_path_test");
    let path = vault_path(&dir, "76561199140017878");
    assert_eq!(path, dir.join("accounts").join("76561199140017878.bin"));
    assert!(path.starts_with(dir.join("accounts")));
}

#[test]
fn saved_accounts_meta_round_trips() {
    let dir = std::env::temp_dir().join("efxlve_steam_accounts_test");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");

    let accounts = vec![
        SteamSavedAccount {
            steam_id: "76561199140017878".into(),
            account_name: "efxlve".into(),
            last_used: 1_790_000_000,
            is_active: true,
        },
        SteamSavedAccount {
            steam_id: "76561198000000000".into(),
            account_name: "other".into(),
            last_used: 1_780_000_000,
            is_active: false,
        },
    ];
    save_meta(&dir, &accounts);
    let loaded = load_meta(&dir);
    assert_eq!(loaded.len(), 2);
    assert!(loaded[0].is_active);
    assert_eq!(loaded[0].account_name, "efxlve");
    assert_eq!(loaded[1].steam_id, "76561198000000000");

    // Vault paths are namespaced per SteamID64.
    assert!(vault_path(&dir, "76561199140017878")
        .to_string_lossy()
        .ends_with("accounts\\76561199140017878.bin"));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn qr_codes_render_inline_svg() {
    let svg = qr_svg("https://s.team/q/1/123456789").expect("qr svg");
    assert!(
        svg.contains("<svg"),
        "expected SVG markup, got: {}",
        &svg[..svg.len().min(60)]
    );
    assert!(svg.contains("</svg>"));
    assert!(svg.len() > 200);
    assert!(qr_svg("").is_ok(), "an empty payload still renders");
}

#[test]
fn jwt_subject_is_read_from_the_payload() {
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&serde_json::json!({ "sub": "76561199140017878" })).unwrap());
    let token = format!("header.{payload}.signature");
    assert_eq!(jwt_sub(&token).as_deref(), Some("76561199140017878"));
    assert!(jwt_sub("not-a-jwt").is_none());
}

/// Live probe that validates the whole poll path without credentials:
/// `BeginAuthSessionViaQR` creates a real session, then the protobuf
/// `PollAuthSessionStatus` must answer `eresult 1` (still pending).
/// Run: `cargo test live_steam_qr_poll_probe -- --ignored --nocapture`
#[test]
#[ignore]
fn live_steam_qr_poll_probe() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let client = http_client().unwrap();

        let call = post_form(
            &client,
            "BeginAuthSessionViaQR",
            &protobuf_payload(&encode_qr_begin_request()),
        )
        .await
        .unwrap();
        println!("qr begin eresult: {}", call.eresult);
        let keys: Vec<String> = call
            .response()
            .as_object()
            .map(|obj| obj.keys().cloned().collect())
            .unwrap_or_default();
        // Redact the challenge URL before printing anything.
        let mut safe = call.body.clone();
        if let Some(response) = safe.get_mut("response").and_then(|r| r.as_object_mut()) {
            if response.contains_key("challenge_url") {
                response.insert("challenge_url".into(), Value::String("[redacted]".into()));
            }
        }
        println!(
            "body preview: {}",
            serde_json::to_string(&safe)
                .unwrap_or_default()
                .chars()
                .take(400)
                .collect::<String>()
        );
        println!("response keys: {keys:?}");
        assert_eq!(call.eresult, 1, "QR begin must succeed");

        let client_id = field_str(call.response(), "client_id", "clientId");
        let request_b64 = field_str(call.response(), "request_id", "requestId");
        let request_id = decode_base64_bytes(&request_b64);
        let challenge_url = field_str(call.response(), "challenge_url", "challengeUrl");
        println!(
            "client_id: {} digits, request_id: {} base64 chars -> {} bytes, interval: {:?}",
            client_id.len(),
            request_b64.len(),
            request_id.len(),
            call.response().get("interval")
        );
        assert!(!client_id.is_empty(), "client_id must be present");
        assert!(!request_id.is_empty(), "request_id must decode");

        // The sign-in card embeds exactly this markup.
        let svg = qr_svg(&challenge_url).expect("qr svg");
        println!(
            "challenge url: {} chars, svg: {} bytes",
            challenge_url.len(),
            svg.len()
        );
        assert!(svg.contains("<svg"), "QR markup must render");

        let poll = encode_poll_request(&client_id, &request_id);
        let result = post_form(&client, "PollAuthSessionStatus", &protobuf_payload(&poll))
            .await
            .unwrap();
        let poll_keys: Vec<String> = result
            .response()
            .as_object()
            .map(|obj| obj.keys().cloned().collect())
            .unwrap_or_default();
        println!("poll eresult: {} keys: {poll_keys:?}", result.eresult);
        assert_eq!(result.eresult, 1, "a fresh session must poll OK");
    });
}

/// Live probe for the owned-library path using the launcher's own sealed
/// session (`%APPDATA%\com.efxlve.launcher\steam\accounts\<steamid>.bin`,
/// same Windows user). Prints counts only, never tokens.
/// Run: `cargo test live_steam_owned_probe -- --ignored --nocapture`
#[test]
#[ignore]
fn live_steam_owned_probe() {
    use zeroize::Zeroizing;
    let appdata = std::env::var("APPDATA").expect("APPDATA");
    let steam_dir = PathBuf::from(appdata)
        .join("com.efxlve.launcher")
        .join("steam");
    // The vault keeps one sealed file per SteamID64; the active row wins,
    // otherwise the first saved account is used.
    let accounts = load_meta(&steam_dir);
    let steam_id = accounts
        .iter()
        .find(|account| account.is_active)
        .or_else(|| accounts.first())
        .map(|account| account.steam_id.clone())
        .expect("a saved Steam account");
    let sealed = std::fs::read(vault_path(&steam_dir, &steam_id)).expect("sealed session file");
    let plain = Zeroizing::new(dpapi::unprotect(&sealed).expect("dpapi open"));
    let stored: StoredSession = serde_json::from_slice(&plain).expect("stored session");
    println!(
        "account: {}, steam_id: {} chars, saved_at: {}",
        stored.account_name,
        stored.steam_id.len(),
        stored.saved_at
    );

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
        let client = http_client().unwrap();
        let token = finalize_web_login(&client, &stored.refresh_token, &stored.steam_id).await;
        match &token {
            Ok(token) => println!("access token: {} chars", token.len()),
            Err(err) => println!("finalize error: {err}"),
        }
        let Ok(token) = token else { return };
        match fetch_owned_games(&client, &token, &stored.steam_id).await {
            Ok(owned) => {
                println!("owned: {} games", owned.game_count);
                for game in owned.games.iter().take(3) {
                    println!("  {} {}", game.app_id, game.name);
                }
                assert!(owned.game_count > 0, "the account owns games");
            }
            Err(err) => panic!("owned request failed: {err}"),
        }
    });
}
