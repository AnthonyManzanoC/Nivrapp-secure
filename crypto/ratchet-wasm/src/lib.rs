//! Portability probe only. No sessions, prekey reservation or client capability
//! is advertised by this crate. All primitives come from the pinned Signal core.
use libsignal_protocol::{IdentityKeyPair, PublicKey};
use rand::{SeedableRng, rngs::StdRng};
use wasm_bindgen::prelude::*;

fn error(message: &str) -> JsValue { JsValue::from_str(message) }
fn rng() -> Result<StdRng, JsValue> {
    StdRng::try_from_os_rng().map_err(|_| error("Secure system randomness is unavailable"))
}
fn identity(bytes: &[u8]) -> Result<IdentityKeyPair, JsValue> {
    if bytes.len() > 1024 { return Err(error("Identity size exceeds bridge limit")); }
    let pair = IdentityKeyPair::try_from(bytes).map_err(|_| error("Invalid identity encoding"))?;
    let derived = pair.private_key().public_key().map_err(|_| error("Invalid private key"))?;
    if derived.serialize().as_ref() != pair.identity_key().serialize().as_ref() {
        return Err(error("Identity public and private keys do not match"));
    }
    Ok(pair)
}
#[wasm_bindgen(js_name = bridgeVersion)]
pub fn bridge_version() -> String { "NIVRA-LIBSIGNAL-WASM-PORTABILITY-1".into() }

/// Private identity bytes must be protected by the caller before persistence.
/// These functions are intentionally absent from Angular/Electron production.
#[wasm_bindgen(js_name = createIdentity)]
pub fn create_identity() -> Result<Vec<u8>, JsValue> {
    Ok(IdentityKeyPair::generate(&mut rng()?).serialize().to_vec())
}
#[wasm_bindgen(js_name = identityPublic)]
pub fn identity_public(bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    Ok(identity(bytes)?.identity_key().serialize().to_vec())
}
#[wasm_bindgen(js_name = signIdentity)]
pub fn sign_identity(bytes: &[u8], message: &[u8]) -> Result<Vec<u8>, JsValue> {
    if message.len() > 131072 { return Err(error("Signature context exceeds bridge limit")); }
    identity(bytes)?.private_key().calculate_signature(message, &mut rng()?)
        .map(|signature| signature.to_vec()).map_err(|_| error("Signature creation failed"))
}
#[wasm_bindgen(js_name = verifyIdentity)]
pub fn verify_identity(public: &[u8], message: &[u8], signature: &[u8]) -> Result<bool, JsValue> {
    if public.len() != 33 || signature.len() != 64 || message.len() > 131072 {
        return Err(error("Invalid signature input bounds"));
    }
    let public = PublicKey::deserialize(public).map_err(|_| error("Invalid public key"))?;
    Ok(public.verify_signature(message, signature))
}
