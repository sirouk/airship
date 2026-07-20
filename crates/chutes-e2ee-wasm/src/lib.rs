use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use chacha20poly1305::{
    ChaCha20Poly1305, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use getrandom::fill as random_fill;
use hkdf::Hkdf;
use js_sys::{Error as JsError, Reflect};
use ml_kem::{
    DecapsulationKey768, EncapsulationKey768, MlKem768, Seed,
    kem::{Decapsulate, Encapsulate, Kem, KeyExport},
};
use serde_json::Value;
use sha2::Sha256;
use std::{
    collections::HashSet,
    io::{Read, Write},
};
use thiserror::Error;
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;

const MLKEM_PK_SIZE: usize = 1_184;
const MLKEM_SEED_SIZE: usize = 64;
const MLKEM_CT_SIZE: usize = 1_088;
const AEAD_NONCE_SIZE: usize = 12;
const AEAD_TAG_SIZE: usize = 16;
const INFO_REQ: &[u8] = b"e2e-req-v1";
const INFO_RESP: &[u8] = b"e2e-resp-v1";
const INFO_STREAM: &[u8] = b"e2e-stream-v1";

/// Maximum unencrypted request JSON accepted by the v1 encoder (8 MiB).
pub const MAX_PAYLOAD_JSON_BYTES: usize = 8 * 1024 * 1024;
/// Maximum complete encrypted request frame emitted by the encoder (16 MiB).
pub const MAX_REQUEST_FRAME_BYTES: usize = 16 * 1024 * 1024;
/// Maximum complete encrypted non-stream response frame accepted (64 MiB).
pub const MAX_RESPONSE_FRAME_BYTES: usize = 64 * 1024 * 1024;
/// Maximum plaintext produced by non-stream response decompression (64 MiB).
pub const MAX_RESPONSE_PLAINTEXT_BYTES: usize = 64 * 1024 * 1024;
/// Maximum decoded encrypted stream record, including nonce and tag (4 MiB).
pub const MAX_STREAM_CHUNK_BYTES: usize = 4 * 1024 * 1024;
/// Maximum successfully authenticated records in one stream context.
pub const MAX_STREAM_CHUNKS: u32 = 131_072;

const MAX_KEY_B64_BYTES: usize = 2_048;
const MAX_STREAM_INIT_B64_BYTES: usize = 2_048;
const MAX_STREAM_CHUNK_B64_BYTES: usize = MAX_STREAM_CHUNK_BYTES.div_ceil(3) * 4;

type E2Result<T> = Result<T, E2eeError>;

/// Stable Rust-side error variants. The WASM boundary converts these to
/// `ChutesE2eeError` JavaScript errors with a stable string `code` property.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum E2eeError {
    #[error("request payload is {actual} bytes; maximum is {max}")]
    PayloadTooLarge { actual: usize, max: usize },
    #[error("request payload must be a JSON object")]
    PayloadNotObject,
    #[error("request payload is not valid JSON: {0}")]
    InvalidPayloadJson(String),
    #[error("{field} base64 is invalid")]
    InvalidBase64 { field: &'static str },
    #[error("{field} base64 is {actual} bytes; maximum encoded length is {max}")]
    Base64TooLarge {
        field: &'static str,
        actual: usize,
        max: usize,
    },
    #[error("Chutes E2EE public key is {actual} bytes; expected {expected}")]
    InvalidPublicKeyLength { actual: usize, expected: usize },
    #[error("Chutes E2EE public key failed ML-KEM validation")]
    InvalidPublicKey,
    #[error("secure random generation failed")]
    Randomness,
    #[error("HKDF key derivation failed")]
    KeyDerivation,
    #[error("gzip compression failed: {0}")]
    Compression(String),
    #[error("gzip decompression failed: {0}")]
    Decompression(String),
    #[error("decompressed response exceeds {max} bytes")]
    DecompressedResponseTooLarge { max: usize },
    #[error("encrypted request frame is {actual} bytes; maximum is {max}")]
    RequestFrameTooLarge { actual: usize, max: usize },
    #[error("encrypted response frame is {actual} bytes; minimum is {min}")]
    ResponseFrameTooShort { actual: usize, min: usize },
    #[error("encrypted response frame is {actual} bytes; maximum is {max}")]
    ResponseFrameTooLarge { actual: usize, max: usize },
    #[error("response key material has an invalid length")]
    InvalidResponseKey,
    #[error("ML-KEM ciphertext is too short")]
    KemCiphertextTooShort,
    #[error("ChaCha20-Poly1305 authentication failed")]
    AuthenticationFailed,
    #[error("decrypted plaintext is not valid UTF-8")]
    InvalidUtf8,
    #[error("request body has already been taken")]
    RequestBodyConsumed,
    #[error("response context has already been consumed")]
    ResponseContextConsumed,
    #[error("stream init ciphertext is {actual} bytes; expected {expected}")]
    InvalidStreamInitLength { actual: usize, expected: usize },
    #[error("encrypted stream record is {actual} bytes; minimum is {min}")]
    StreamChunkTooShort { actual: usize, min: usize },
    #[error("encrypted stream record is {actual} bytes; maximum is {max}")]
    StreamChunkTooLarge { actual: usize, max: usize },
    #[error("stream record reuses a previously authenticated nonce")]
    StreamNonceReuse,
    #[error("stream has reached its limit of {max} authenticated records")]
    StreamChunkLimit { max: u32 },
    #[error("stream context has been finished")]
    StreamFinished,
    #[error("internal serialization failed: {0}")]
    Serialization(String),
    #[error("internal key state is unavailable")]
    InternalKeyState,
}

impl E2eeError {
    /// Stable machine-readable code also attached to JavaScript errors.
    pub const fn code(&self) -> &'static str {
        match self {
            Self::PayloadTooLarge { .. } => "PAYLOAD_TOO_LARGE",
            Self::PayloadNotObject => "PAYLOAD_NOT_OBJECT",
            Self::InvalidPayloadJson(_) => "INVALID_PAYLOAD_JSON",
            Self::InvalidBase64 { .. } => "INVALID_BASE64",
            Self::Base64TooLarge { .. } => "BASE64_TOO_LARGE",
            Self::InvalidPublicKeyLength { .. } => "INVALID_PUBLIC_KEY_LENGTH",
            Self::InvalidPublicKey => "INVALID_PUBLIC_KEY",
            Self::Randomness => "RANDOMNESS_FAILED",
            Self::KeyDerivation => "KEY_DERIVATION_FAILED",
            Self::Compression(_) => "COMPRESSION_FAILED",
            Self::Decompression(_) => "DECOMPRESSION_FAILED",
            Self::DecompressedResponseTooLarge { .. } => "DECOMPRESSED_RESPONSE_TOO_LARGE",
            Self::RequestFrameTooLarge { .. } => "REQUEST_FRAME_TOO_LARGE",
            Self::ResponseFrameTooShort { .. } => "RESPONSE_FRAME_TOO_SHORT",
            Self::ResponseFrameTooLarge { .. } => "RESPONSE_FRAME_TOO_LARGE",
            Self::InvalidResponseKey => "INVALID_RESPONSE_KEY",
            Self::KemCiphertextTooShort => "KEM_CIPHERTEXT_TOO_SHORT",
            Self::AuthenticationFailed => "AUTHENTICATION_FAILED",
            Self::InvalidUtf8 => "INVALID_UTF8",
            Self::RequestBodyConsumed => "REQUEST_BODY_CONSUMED",
            Self::ResponseContextConsumed => "RESPONSE_CONTEXT_CONSUMED",
            Self::InvalidStreamInitLength { .. } => "INVALID_STREAM_INIT_LENGTH",
            Self::StreamChunkTooShort { .. } => "STREAM_CHUNK_TOO_SHORT",
            Self::StreamChunkTooLarge { .. } => "STREAM_CHUNK_TOO_LARGE",
            Self::StreamNonceReuse => "STREAM_NONCE_REUSE",
            Self::StreamChunkLimit { .. } => "STREAM_CHUNK_LIMIT",
            Self::StreamFinished => "STREAM_FINISHED",
            Self::Serialization(_) => "SERIALIZATION_FAILED",
            Self::InternalKeyState => "INTERNAL_KEY_STATE",
        }
    }
}

/// Opaque one-request capability. It owns the response decapsulation seed and
/// never exports it to JavaScript. A response attempt or stream-open attempt
/// consumes that seed even when authentication fails.
#[wasm_bindgen]
pub struct E2eeRequestContext {
    request_blob: Option<Vec<u8>>,
    response_seed: Option<Zeroizing<Seed>>,
}

#[wasm_bindgen]
impl E2eeRequestContext {
    /// Moves the encrypted request body into JavaScript exactly once.
    pub fn take_blob(&mut self) -> Result<Vec<u8>, JsValue> {
        self.take_blob_core().map_err(js_error)
    }

    /// Decrypts one non-stream v1 response and consumes the response secret.
    pub fn decrypt_response(&mut self, response_blob: &[u8]) -> Result<String, JsValue> {
        self.decrypt_response_once(response_blob).map_err(js_error)
    }

    /// Consumes the response secret, authenticates the v1 stream init, and
    /// returns an opaque stream context. A failed open is not retryable.
    pub fn open_stream(&mut self, mlkem_ct_b64: &str) -> Result<E2eeStreamContext, JsValue> {
        self.open_stream_once(mlkem_ct_b64).map_err(js_error)
    }

    /// True after `decrypt_response` or `open_stream` has consumed the secret.
    #[wasm_bindgen(getter)]
    pub fn consumed(&self) -> bool {
        self.response_seed.is_none()
    }

    /// True after `take_blob` has moved out the request frame.
    #[wasm_bindgen(getter)]
    pub fn blob_taken(&self) -> bool {
        self.request_blob.is_none()
    }
}

impl E2eeRequestContext {
    fn take_blob_core(&mut self) -> E2Result<Vec<u8>> {
        self.request_blob
            .take()
            .ok_or(E2eeError::RequestBodyConsumed)
    }

    fn take_response_seed(&mut self) -> E2Result<Zeroizing<Seed>> {
        self.response_seed
            .take()
            .ok_or(E2eeError::ResponseContextConsumed)
    }

    fn decrypt_response_once(&mut self, response_blob: &[u8]) -> E2Result<String> {
        let response_seed = self.take_response_seed()?;
        decrypt_response_core(response_blob, response_seed.as_slice())
    }

    fn open_stream_once(&mut self, mlkem_ct_b64: &str) -> E2Result<E2eeStreamContext> {
        let response_seed = self.take_response_seed()?;
        let stream_key = decrypt_stream_init_core(response_seed.as_slice(), mlkem_ct_b64)?;
        Ok(E2eeStreamContext::new(stream_key))
    }
}

/// Opaque v1 stream decryptor. It rejects duplicate authenticated nonces and
/// bounds record count/size. V1 has no sequence number or authenticated FIN,
/// so ordering and completeness cannot be proven by this context.
#[wasm_bindgen]
pub struct E2eeStreamContext {
    stream_key: Option<Zeroizing<[u8; 32]>>,
    seen_nonces: HashSet<[u8; AEAD_NONCE_SIZE]>,
    chunks_decrypted: u32,
    max_chunks: u32,
}

#[wasm_bindgen]
impl E2eeStreamContext {
    /// Authenticates and decrypts one base64 v1 `nonce || ciphertext || tag`
    /// record. Duplicate successfully authenticated nonces are rejected.
    pub fn decrypt_chunk(&mut self, enc_chunk_b64: &str) -> Result<String, JsValue> {
        self.decrypt_chunk_core(enc_chunk_b64).map_err(js_error)
    }

    /// Immediately destroys the stream key. This is local disposal only; v1
    /// does not provide an authenticated final record to verify here.
    pub fn finish(&mut self) {
        self.finish_core();
    }

    #[wasm_bindgen(getter)]
    pub fn finished(&self) -> bool {
        self.stream_key.is_none()
    }

    #[wasm_bindgen(getter)]
    pub fn chunks_decrypted(&self) -> u32 {
        self.chunks_decrypted
    }
}

impl E2eeStreamContext {
    fn new(stream_key: Zeroizing<[u8; 32]>) -> Self {
        Self {
            stream_key: Some(stream_key),
            seen_nonces: HashSet::new(),
            chunks_decrypted: 0,
            max_chunks: MAX_STREAM_CHUNKS,
        }
    }

    #[cfg(test)]
    fn with_chunk_limit(stream_key: [u8; 32], max_chunks: u32) -> Self {
        Self {
            max_chunks,
            ..Self::new(Zeroizing::new(stream_key))
        }
    }

    fn decrypt_chunk_core(&mut self, enc_chunk_b64: &str) -> E2Result<String> {
        let key = self.stream_key.as_ref().ok_or(E2eeError::StreamFinished)?;
        if self.chunks_decrypted >= self.max_chunks {
            return Err(E2eeError::StreamChunkLimit {
                max: self.max_chunks,
            });
        }
        check_b64_bound("stream chunk", enc_chunk_b64, MAX_STREAM_CHUNK_B64_BYTES)?;
        let raw = decode_b64("stream chunk", enc_chunk_b64)?;
        let minimum = AEAD_NONCE_SIZE + AEAD_TAG_SIZE;
        if raw.len() < minimum {
            return Err(E2eeError::StreamChunkTooShort {
                actual: raw.len(),
                min: minimum,
            });
        }
        if raw.len() > MAX_STREAM_CHUNK_BYTES {
            return Err(E2eeError::StreamChunkTooLarge {
                actual: raw.len(),
                max: MAX_STREAM_CHUNK_BYTES,
            });
        }

        let mut nonce = [0u8; AEAD_NONCE_SIZE];
        nonce.copy_from_slice(&raw[..AEAD_NONCE_SIZE]);
        if self.seen_nonces.contains(&nonce) {
            return Err(E2eeError::StreamNonceReuse);
        }

        let plaintext = open(key, &nonce, &raw[AEAD_NONCE_SIZE..])?;
        let text = String::from_utf8(plaintext).map_err(|_| E2eeError::InvalidUtf8)?;
        self.seen_nonces.insert(nonce);
        self.chunks_decrypted += 1;
        Ok(text)
    }

    fn finish_core(&mut self) {
        self.stream_key.take();
        self.seen_nonces.clear();
    }
}

/// Builds a Chutes E2EE v1 request. The returned context exposes only the
/// encrypted body; response key material remains inside the opaque context.
#[wasm_bindgen]
pub fn build_e2ee_request(
    e2e_pubkey_b64: &str,
    payload_json: &str,
) -> Result<E2eeRequestContext, JsValue> {
    build_request(e2e_pubkey_b64, payload_json).map_err(js_error)
}

fn build_request(e2e_pubkey_b64: &str, payload_json: &str) -> E2Result<E2eeRequestContext> {
    if payload_json.len() > MAX_PAYLOAD_JSON_BYTES {
        return Err(E2eeError::PayloadTooLarge {
            actual: payload_json.len(),
            max: MAX_PAYLOAD_JSON_BYTES,
        });
    }
    check_b64_bound("Chutes E2EE public key", e2e_pubkey_b64, MAX_KEY_B64_BYTES)?;

    let Value::Object(mut payload) = serde_json::from_str(payload_json)
        .map_err(|error| E2eeError::InvalidPayloadJson(error.to_string()))?
    else {
        return Err(E2eeError::PayloadNotObject);
    };

    let e2e_pubkey = decode_b64("Chutes E2EE public key", e2e_pubkey_b64)?;
    if e2e_pubkey.len() != MLKEM_PK_SIZE {
        return Err(E2eeError::InvalidPublicKeyLength {
            actual: e2e_pubkey.len(),
            expected: MLKEM_PK_SIZE,
        });
    }
    let e2e_pubkey = e2e_pubkey
        .as_slice()
        .try_into()
        .map_err(|_| E2eeError::InvalidPublicKey)?;
    let e2e_pubkey =
        EncapsulationKey768::new(&e2e_pubkey).map_err(|_| E2eeError::InvalidPublicKey)?;

    let (response_sk, response_pk): (DecapsulationKey768, EncapsulationKey768) =
        MlKem768::generate_keypair();
    let response_seed = response_sk.to_seed().ok_or(E2eeError::InternalKeyState)?;
    let response_seed = Zeroizing::new(response_seed);
    payload.insert(
        "e2e_response_pk".to_string(),
        Value::String(B64.encode(response_pk.to_bytes())),
    );

    let (mlkem_ct, shared_secret) = e2e_pubkey.encapsulate();
    let mlkem_ct = mlkem_ct.to_vec();
    let shared_secret = Zeroizing::new(shared_secret);
    let sym_key = derive_key(shared_secret.as_ref(), &mlkem_ct, INFO_REQ)?;

    let encoded = Zeroizing::new(
        serde_json::to_vec(&payload)
            .map_err(|error| E2eeError::Serialization(error.to_string()))?,
    );
    let compressed = Zeroizing::new(gzip_compress(&encoded)?);
    let mut nonce = [0u8; AEAD_NONCE_SIZE];
    random_fill(&mut nonce).map_err(|_| E2eeError::Randomness)?;
    let ciphertext_and_tag = seal(&sym_key, &nonce, &compressed)?;

    let frame_len = MLKEM_CT_SIZE + AEAD_NONCE_SIZE + ciphertext_and_tag.len();
    if frame_len > MAX_REQUEST_FRAME_BYTES {
        return Err(E2eeError::RequestFrameTooLarge {
            actual: frame_len,
            max: MAX_REQUEST_FRAME_BYTES,
        });
    }
    let mut blob = Vec::with_capacity(frame_len);
    blob.extend_from_slice(&mlkem_ct);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext_and_tag);

    Ok(E2eeRequestContext {
        request_blob: Some(blob),
        response_seed: Some(response_seed),
    })
}

fn decrypt_response_core(response_blob: &[u8], response_seed: &[u8]) -> E2Result<String> {
    let minimum = MLKEM_CT_SIZE + AEAD_NONCE_SIZE + AEAD_TAG_SIZE;
    if response_blob.len() < minimum {
        return Err(E2eeError::ResponseFrameTooShort {
            actual: response_blob.len(),
            min: minimum,
        });
    }
    if response_blob.len() > MAX_RESPONSE_FRAME_BYTES {
        return Err(E2eeError::ResponseFrameTooLarge {
            actual: response_blob.len(),
            max: MAX_RESPONSE_FRAME_BYTES,
        });
    }

    let mlkem_ct = &response_blob[..MLKEM_CT_SIZE];
    let nonce = &response_blob[MLKEM_CT_SIZE..MLKEM_CT_SIZE + AEAD_NONCE_SIZE];
    let ciphertext_and_tag = &response_blob[MLKEM_CT_SIZE + AEAD_NONCE_SIZE..];
    let sk = decapsulation_key_from_seed(response_seed)?;
    let ct = mlkem_ct
        .try_into()
        .map_err(|_| E2eeError::InvalidResponseKey)?;
    let shared_secret = Zeroizing::new(sk.decapsulate(&ct));
    let sym_key = derive_key(shared_secret.as_ref(), mlkem_ct, INFO_RESP)?;
    let compressed = Zeroizing::new(open(&sym_key, nonce, ciphertext_and_tag)?);
    let plaintext = gzip_decompress_limited(&compressed, MAX_RESPONSE_PLAINTEXT_BYTES)?;
    String::from_utf8(plaintext).map_err(|_| E2eeError::InvalidUtf8)
}

fn decrypt_stream_init_core(
    response_seed: &[u8],
    mlkem_ct_b64: &str,
) -> E2Result<Zeroizing<[u8; 32]>> {
    check_b64_bound("stream init", mlkem_ct_b64, MAX_STREAM_INIT_B64_BYTES)?;
    let mlkem_ct = decode_b64("stream init", mlkem_ct_b64)?;
    if mlkem_ct.len() != MLKEM_CT_SIZE {
        return Err(E2eeError::InvalidStreamInitLength {
            actual: mlkem_ct.len(),
            expected: MLKEM_CT_SIZE,
        });
    }
    let sk = decapsulation_key_from_seed(response_seed)?;
    let ct = mlkem_ct
        .as_slice()
        .try_into()
        .map_err(|_| E2eeError::InvalidResponseKey)?;
    let shared_secret = Zeroizing::new(sk.decapsulate(&ct));
    derive_key(shared_secret.as_ref(), &mlkem_ct, INFO_STREAM)
}

fn decapsulation_key_from_seed(response_seed: &[u8]) -> E2Result<DecapsulationKey768> {
    if response_seed.len() != MLKEM_SEED_SIZE {
        return Err(E2eeError::InvalidResponseKey);
    }
    let mut seed = Seed::default();
    seed.as_mut_slice().copy_from_slice(response_seed);
    Ok(DecapsulationKey768::from_seed(seed))
}

fn derive_key(shared_secret: &[u8], mlkem_ct: &[u8], info: &[u8]) -> E2Result<Zeroizing<[u8; 32]>> {
    if mlkem_ct.len() < 16 {
        return Err(E2eeError::KemCiphertextTooShort);
    }
    let hk = Hkdf::<Sha256>::new(Some(&mlkem_ct[..16]), shared_secret);
    let mut key = Zeroizing::new([0u8; 32]);
    hk.expand(info, &mut *key)
        .map_err(|_| E2eeError::KeyDerivation)?;
    Ok(key)
}

// Chutes E2EE v1 deliberately uses empty AAD. Changing this would break the
// deployed protocol; routing/header binding belongs in a negotiated v2 suite.
fn seal(key: &[u8; 32], nonce: &[u8; AEAD_NONCE_SIZE], plaintext: &[u8]) -> E2Result<Vec<u8>> {
    let nonce = Nonce::try_from(nonce.as_slice()).map_err(|_| E2eeError::AuthenticationFailed)?;
    ChaCha20Poly1305::new(key.into())
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad: &[],
            },
        )
        .map_err(|_| E2eeError::AuthenticationFailed)
}

fn open(key: &[u8; 32], nonce: &[u8], ciphertext_and_tag: &[u8]) -> E2Result<Vec<u8>> {
    let nonce = Nonce::try_from(nonce).map_err(|_| E2eeError::AuthenticationFailed)?;
    ChaCha20Poly1305::new(key.into())
        .decrypt(
            &nonce,
            Payload {
                msg: ciphertext_and_tag,
                aad: &[],
            },
        )
        .map_err(|_| E2eeError::AuthenticationFailed)
}

fn gzip_compress(bytes: &[u8]) -> E2Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(bytes)
        .map_err(|error| E2eeError::Compression(error.to_string()))?;
    encoder
        .finish()
        .map_err(|error| E2eeError::Compression(error.to_string()))
}

fn gzip_decompress_limited(bytes: &[u8], limit: usize) -> E2Result<Vec<u8>> {
    let decoder = GzDecoder::new(bytes);
    let mut bounded = decoder.take((limit as u64).saturating_add(1));
    let mut out = Vec::new();
    bounded
        .read_to_end(&mut out)
        .map_err(|error| E2eeError::Decompression(error.to_string()))?;
    if out.len() > limit {
        return Err(E2eeError::DecompressedResponseTooLarge { max: limit });
    }
    Ok(out)
}

fn check_b64_bound(field: &'static str, value: &str, max: usize) -> E2Result<()> {
    if value.len() > max {
        return Err(E2eeError::Base64TooLarge {
            field,
            actual: value.len(),
            max,
        });
    }
    Ok(())
}

fn decode_b64(field: &'static str, value: &str) -> E2Result<Vec<u8>> {
    B64.decode(value)
        .map_err(|_| E2eeError::InvalidBase64 { field })
}

fn js_error(error: E2eeError) -> JsValue {
    let js_error = JsError::new(&error.to_string());
    let _ = Reflect::set(
        js_error.as_ref(),
        &JsValue::from_str("name"),
        &JsValue::from_str("ChutesE2eeError"),
    );
    let _ = Reflect::set(
        js_error.as_ref(),
        &JsValue::from_str("code"),
        &JsValue::from_str(error.code()),
    );
    js_error.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_frame_is_v1_compatible_and_secret_is_opaque() {
        let (server_sk, server_pk): (DecapsulationKey768, EncapsulationKey768) =
            MlKem768::generate_keypair();
        let mut request = build_request(
            &B64.encode(server_pk.to_bytes()),
            r#"{"model":"tee-model","messages":[],"stream":false}"#,
        )
        .unwrap();

        assert_eq!(
            request.response_seed.as_ref().unwrap().len(),
            MLKEM_SEED_SIZE
        );
        let blob = request.take_blob_core().unwrap();
        assert!(blob.len() > MLKEM_CT_SIZE + AEAD_NONCE_SIZE + AEAD_TAG_SIZE);
        let payload = decrypt_request_for_test(&server_sk, &blob);
        assert_eq!(payload["model"], "tee-model");
        assert_eq!(payload["stream"], false);
        assert_eq!(
            B64.decode(payload["e2e_response_pk"].as_str().unwrap())
                .unwrap()
                .len(),
            MLKEM_PK_SIZE
        );
        assert_eq!(
            request.take_blob_core().unwrap_err(),
            E2eeError::RequestBodyConsumed
        );
    }

    #[test]
    fn non_stream_response_round_trips_and_consumes_context() {
        let (server_sk, server_pk): (DecapsulationKey768, EncapsulationKey768) =
            MlKem768::generate_keypair();
        let mut request =
            build_request(&B64.encode(server_pk.to_bytes()), r#"{"model":"m"}"#).unwrap();
        let blob = request.take_blob_core().unwrap();
        let response_pk = response_pk_from_request(&server_sk, &blob);
        let expected = json!({"choices":[{"message":{"content":"hello"}}]}).to_string();
        let encrypted = encrypt_response_for_test(&response_pk, expected.as_bytes());

        assert_eq!(request.decrypt_response_once(&encrypted).unwrap(), expected);
        assert!(request.consumed());
        assert_eq!(
            request.decrypt_response_once(&encrypted).unwrap_err(),
            E2eeError::ResponseContextConsumed
        );
    }

    #[test]
    fn failed_response_authentication_still_consumes_secret() {
        let (_server_sk, server_pk): (DecapsulationKey768, EncapsulationKey768) =
            MlKem768::generate_keypair();
        let mut request =
            build_request(&B64.encode(server_pk.to_bytes()), r#"{"model":"m"}"#).unwrap();
        let invalid = vec![0u8; MLKEM_CT_SIZE + AEAD_NONCE_SIZE + AEAD_TAG_SIZE];

        assert_eq!(
            request.decrypt_response_once(&invalid).unwrap_err(),
            E2eeError::AuthenticationFailed
        );
        assert!(request.consumed());
    }

    #[test]
    fn stream_round_trips_and_rejects_authenticated_nonce_reuse() {
        let (server_sk, server_pk): (DecapsulationKey768, EncapsulationKey768) =
            MlKem768::generate_keypair();
        let mut request =
            build_request(&B64.encode(server_pk.to_bytes()), r#"{"model":"m"}"#).unwrap();
        let blob = request.take_blob_core().unwrap();
        let response_pk = response_pk_from_request(&server_sk, &blob);
        let (init, chunk) = encrypt_stream_for_test(
            &response_pk,
            [7u8; AEAD_NONCE_SIZE],
            br#"data: {"choices":[{"delta":{"content":"hi"}}]}"#,
        );

        let mut stream = request.open_stream_once(&init).unwrap();
        assert_eq!(
            stream.decrypt_chunk_core(&chunk).unwrap(),
            r#"data: {"choices":[{"delta":{"content":"hi"}}]}"#
        );
        assert_eq!(stream.chunks_decrypted(), 1);
        assert_eq!(
            stream.decrypt_chunk_core(&chunk).unwrap_err(),
            E2eeError::StreamNonceReuse
        );
    }

    #[test]
    fn failed_chunk_does_not_reserve_nonce() {
        let key = [9u8; 32];
        let nonce = [3u8; AEAD_NONCE_SIZE];
        let valid = B64.encode([nonce.to_vec(), seal(&key, &nonce, b"ok").unwrap()].concat());
        let mut tampered = B64.decode(&valid).unwrap();
        *tampered.last_mut().unwrap() ^= 1;
        let tampered = B64.encode(tampered);
        let mut stream = E2eeStreamContext::new(Zeroizing::new(key));

        assert_eq!(
            stream.decrypt_chunk_core(&tampered).unwrap_err(),
            E2eeError::AuthenticationFailed
        );
        assert_eq!(stream.decrypt_chunk_core(&valid).unwrap(), "ok");
    }

    #[test]
    fn stream_finish_and_chunk_limit_are_enforced() {
        let key = [5u8; 32];
        let first_nonce = [1u8; AEAD_NONCE_SIZE];
        let second_nonce = [2u8; AEAD_NONCE_SIZE];
        let first = B64.encode(
            [
                first_nonce.to_vec(),
                seal(&key, &first_nonce, b"one").unwrap(),
            ]
            .concat(),
        );
        let second = B64.encode(
            [
                second_nonce.to_vec(),
                seal(&key, &second_nonce, b"two").unwrap(),
            ]
            .concat(),
        );
        let mut stream = E2eeStreamContext::with_chunk_limit(key, 1);

        assert_eq!(stream.decrypt_chunk_core(&first).unwrap(), "one");
        assert_eq!(
            stream.decrypt_chunk_core(&second).unwrap_err(),
            E2eeError::StreamChunkLimit { max: 1 }
        );
        stream.finish_core();
        assert!(stream.finished());
        assert_eq!(
            stream.decrypt_chunk_core(&second).unwrap_err(),
            E2eeError::StreamFinished
        );
    }

    #[test]
    fn malformed_and_oversized_frames_are_rejected() {
        assert_eq!(
            decrypt_response_core(&[0u8; 8], &[0u8; MLKEM_SEED_SIZE]).unwrap_err(),
            E2eeError::ResponseFrameTooShort {
                actual: 8,
                min: MLKEM_CT_SIZE + AEAD_NONCE_SIZE + AEAD_TAG_SIZE
            }
        );
        assert_eq!(
            decrypt_stream_init_core(&[0u8; MLKEM_SEED_SIZE], &B64.encode([0u8; 4])).unwrap_err(),
            E2eeError::InvalidStreamInitLength {
                actual: 4,
                expected: MLKEM_CT_SIZE
            }
        );

        let oversized = "A".repeat(MAX_STREAM_CHUNK_B64_BYTES + 1);
        let mut stream = E2eeStreamContext::new(Zeroizing::new([0u8; 32]));
        assert!(matches!(
            stream.decrypt_chunk_core(&oversized),
            Err(E2eeError::Base64TooLarge {
                field: "stream chunk",
                ..
            })
        ));
    }

    #[test]
    fn decompression_limit_stops_expansion() {
        let compressed = gzip_compress(&[b'x'; 128]).unwrap();
        assert_eq!(
            gzip_decompress_limited(&compressed, 32).unwrap_err(),
            E2eeError::DecompressedResponseTooLarge { max: 32 }
        );
    }

    #[test]
    fn rejects_non_object_invalid_and_oversized_payloads() {
        let (_server_sk, server_pk): (DecapsulationKey768, EncapsulationKey768) =
            MlKem768::generate_keypair();
        let key = B64.encode(server_pk.to_bytes());
        assert_eq!(
            build_request(&key, "[]").err().unwrap(),
            E2eeError::PayloadNotObject
        );
        assert!(matches!(
            build_request(&key, "{").err().unwrap(),
            E2eeError::InvalidPayloadJson(_)
        ));
        let oversized = " ".repeat(MAX_PAYLOAD_JSON_BYTES + 1);
        assert_eq!(
            build_request(&key, &oversized).err().unwrap(),
            E2eeError::PayloadTooLarge {
                actual: MAX_PAYLOAD_JSON_BYTES + 1,
                max: MAX_PAYLOAD_JSON_BYTES
            }
        );
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(
            E2eeError::AuthenticationFailed.code(),
            "AUTHENTICATION_FAILED"
        );
        assert_eq!(E2eeError::StreamNonceReuse.code(), "STREAM_NONCE_REUSE");
        assert_eq!(
            E2eeError::ResponseContextConsumed.code(),
            "RESPONSE_CONTEXT_CONSUMED"
        );
    }

    fn decrypt_request_for_test(server_sk: &DecapsulationKey768, blob: &[u8]) -> Value {
        let mlkem_ct = &blob[..MLKEM_CT_SIZE];
        let nonce = &blob[MLKEM_CT_SIZE..MLKEM_CT_SIZE + AEAD_NONCE_SIZE];
        let ciphertext_and_tag = &blob[MLKEM_CT_SIZE + AEAD_NONCE_SIZE..];
        let ct = mlkem_ct.try_into().unwrap();
        let shared_secret = Zeroizing::new(server_sk.decapsulate(&ct));
        let key = derive_key(shared_secret.as_ref(), mlkem_ct, INFO_REQ).unwrap();
        let compressed = Zeroizing::new(open(&key, nonce, ciphertext_and_tag).unwrap());
        let plaintext = gzip_decompress_limited(&compressed, MAX_PAYLOAD_JSON_BYTES).unwrap();
        serde_json::from_slice(&plaintext).unwrap()
    }

    fn response_pk_from_request(server_sk: &DecapsulationKey768, blob: &[u8]) -> String {
        decrypt_request_for_test(server_sk, blob)["e2e_response_pk"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn encrypt_response_for_test(response_pk_b64: &str, plaintext: &[u8]) -> Vec<u8> {
        let (mlkem_ct, key) = encapsulate_for_response(response_pk_b64, INFO_RESP);
        let nonce = [42u8; AEAD_NONCE_SIZE];
        let compressed = Zeroizing::new(gzip_compress(plaintext).unwrap());
        let ciphertext_and_tag = seal(&key, &nonce, &compressed).unwrap();
        [mlkem_ct, nonce.to_vec(), ciphertext_and_tag].concat()
    }

    fn encrypt_stream_for_test(
        response_pk_b64: &str,
        nonce: [u8; AEAD_NONCE_SIZE],
        plaintext: &[u8],
    ) -> (String, String) {
        let (mlkem_ct, key) = encapsulate_for_response(response_pk_b64, INFO_STREAM);
        let ciphertext_and_tag = seal(&key, &nonce, plaintext).unwrap();
        (
            B64.encode(mlkem_ct),
            B64.encode([nonce.to_vec(), ciphertext_and_tag].concat()),
        )
    }

    fn encapsulate_for_response(
        response_pk_b64: &str,
        info: &[u8],
    ) -> (Vec<u8>, Zeroizing<[u8; 32]>) {
        let pk_bytes = B64.decode(response_pk_b64).unwrap();
        let pk = pk_bytes.as_slice().try_into().unwrap();
        let pk = EncapsulationKey768::new(&pk).unwrap();
        let (mlkem_ct, shared_secret) = pk.encapsulate();
        let mlkem_ct = mlkem_ct.to_vec();
        let shared_secret = Zeroizing::new(shared_secret);
        let key = derive_key(shared_secret.as_ref(), &mlkem_ct, info).unwrap();
        (mlkem_ct, key)
    }
}
