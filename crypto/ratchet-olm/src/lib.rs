//! Device-scoped Double Ratchet adapter. The protocol primitives and sessions
//! come from pinned vodozemac; persistence is encrypted by the application.
use base64ct::{Base64, Encoding};
use serde::{Deserialize, Serialize};
use vodozemac::{Curve25519PublicKey, Ed25519PublicKey, Ed25519Signature};
use vodozemac::olm::{Account, AccountPickle, OlmMessage, Session, SessionConfig, SessionPickle};
use wasm_bindgen::prelude::*;
use zeroize::{Zeroize, Zeroizing};

const SUITE: &str = "NIVRA-OLM-BUNDLE-1";
const PROTOCOL: &str = "NIVRA-OLM-A256GCM-1";
const MAX_STATE: usize = 32 * 1024 * 1024;
fn error(value: &str) -> JsValue { JsValue::from_str(value) }
fn bytes(value: &str, maximum: usize) -> Result<Vec<u8>, JsValue> {
    if value.len() > maximum.div_ceil(3) * 4 { return Err(error("Binary size exceeds limit")); }
    let result = Base64::decode_vec(value).map_err(|_| error("Invalid binary encoding"))?;
    if result.len() > maximum || Base64::encode_string(&result) != value { return Err(error("Noncanonical binary encoding")); }
    Ok(result)
}

#[cfg(test)]
mod vendor_security_checks {
    use super::*;
    #[test]
    fn vendor_rejects_non_contributory_agreement_keys() {
        let account = Account::new(); let other = Account::new();
        let zero = Curve25519PublicKey::from_bytes([0; 32]);
        assert!(account.create_outbound_session(SessionConfig::version_1(), zero, other.curve25519_key()).is_err());
        assert!(account.create_outbound_session(SessionConfig::version_1(), other.curve25519_key(), zero).is_err());
    }
    #[test]
    fn vendor_native_session_and_pickle_survive_a_real_ratchet_turn() {
        let alice = Account::new(); let mut bob = Account::new(); bob.generate_one_time_keys(1);
        let prekey = *bob.one_time_keys().values().next().unwrap();
        let mut outgoing = alice.create_outbound_session(SessionConfig::version_1(), bob.curve25519_key(), prekey).unwrap();
        let first = outgoing.encrypt(b"native first").unwrap();
        let OlmMessage::PreKey(first) = first else { panic!("Expected a handshake") };
        let created = bob.create_inbound_session(SessionConfig::version_1(), alice.curve25519_key(), &first).unwrap();
        assert_eq!(created.plaintext, b"native first");
        assert_eq!(bob.stored_one_time_key_count(), 0);
        let mut incoming = Session::from_pickle(created.session.pickle());
        let reply = incoming.encrypt(b"native reply").unwrap();
        assert_eq!(outgoing.decrypt(&reply).unwrap(), b"native reply");
    }
}
fn account(private: &[u8]) -> Result<Account, JsValue> {
    if private.len() > 256 * 1024 { return Err(error("Identity size exceeds limit")); }
    let pickle: AccountPickle = serde_json::from_slice(private).map_err(|_| error("Invalid private account"))?;
    Ok(Account::from_pickle(pickle))
}
fn public(account: &Account) -> Vec<u8> {
    [account.curve25519_key().as_bytes().as_slice(), account.ed25519_key().as_bytes().as_slice()].concat()
}
fn public_keys(value: &[u8]) -> Result<(Curve25519PublicKey, Ed25519PublicKey), JsValue> {
    if value.len() != 64 { return Err(error("Invalid device public identity")); }
    let curve = Curve25519PublicKey::from_slice(&value[..32]).map_err(|_| error("Invalid agreement public key"))?;
    let signing = Ed25519PublicKey::from_slice(value[32..].try_into().map_err(|_| error("Invalid signing key length"))?).map_err(|_| error("Invalid signing public key"))?;
    Ok((curve, signing))
}
fn address(name: &str, device: u32) -> Result<(), JsValue> {
    if name.is_empty() || name.len() > 128 || !name.bytes().all(|value| value.is_ascii_alphanumeric() || b"_-".contains(&value)) || device != 1 { return Err(error("Invalid device address")); }
    Ok(())
}
#[wasm_bindgen(js_name = protocolSuite)]
pub fn protocol_suite() -> String { PROTOCOL.into() }
#[wasm_bindgen(js_name = bridgeVersion)]
pub fn bridge_version() -> String { "NIVRA-OLM-WASM-1".into() }
#[wasm_bindgen(js_name = createIdentity)]
pub fn create_identity() -> Result<Vec<u8>, JsValue> {
    // A system RNG failure traps; no weak/random fallback is provided.
    serde_json::to_vec(&Account::new().pickle()).map_err(|_| error("Account initialization failed"))
}
#[wasm_bindgen(js_name = identityPublic)]
pub fn identity_public(private: &[u8]) -> Result<Vec<u8>, JsValue> { Ok(public(&account(private)?)) }
#[wasm_bindgen(js_name = signIdentity)]
pub fn sign_identity(private: &[u8], message: &[u8]) -> Result<Vec<u8>, JsValue> {
    if message.len() > 131072 { return Err(error("Signature input exceeds limit")); }
    Ok(account(private)?.sign(message).to_bytes().to_vec())
}
#[wasm_bindgen(js_name = verifyIdentity)]
pub fn verify_identity(identity: &[u8], message: &[u8], signature: &[u8]) -> Result<bool, JsValue> {
    if message.len() > 131072 || signature.len() != 64 { return Err(error("Invalid signature input")); }
    let (_, signing) = public_keys(identity)?;
    let signature = Ed25519Signature::from_slice(signature).map_err(|_| error("Invalid signature"))?;
    Ok(signing.verify(message, &signature).is_ok())
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle { v: u8, suite: String, registration_id: u32, device_id: u32, identity_key: String, pre_key_id: u32, pre_key_public: String, signature: String }
impl Bundle {
    fn signed_bytes(&self) -> Result<Vec<u8>, JsValue> {
        serde_json::to_vec(&(self.v, &self.suite, self.registration_id, self.device_id, &self.identity_key, self.pre_key_id, &self.pre_key_public)).map_err(|_| error("Bundle serialization failed"))
    }
}
struct Peer { name: String, device: u32, identity: String, sessions: Vec<Session> }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedPeer { name: String, device: u32, identity: String, session: Option<String> }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State { v: u8, protocol: String, name: String, device: u32, registration: u32, identity: String, counter: u32, peers: Vec<SavedPeer> }
#[wasm_bindgen]
pub struct RatchetDevice { name: String, device: u32, registration: u32, account: Account, counter: u32, peers: Vec<Peer>, transaction: u32, checkpoint: Option<(u32, Zeroizing<String>)> }
impl RatchetDevice {
    fn peer_index(&self, name: &str, device: u32) -> Result<usize, JsValue> {
        address(name, device)?;
        self.peers.iter().position(|peer| peer.name == name && peer.device == device).ok_or_else(|| error("Unpinned peer"))
    }
    fn snapshot(&self) -> Result<String, JsValue> {
        let mut peers = Vec::with_capacity(self.peers.len());
        for peer in &self.peers {
            let session = if peer.sessions.is_empty() { None } else { Some(serde_json::to_string(&peer.sessions.iter().map(Session::pickle).collect::<Vec<_>>()).map_err(|_| error("Session snapshot failed"))?) };
            peers.push(SavedPeer { name: peer.name.clone(), device: peer.device, identity: peer.identity.clone(), session });
        }
        let mut private = serde_json::to_vec(&self.account.pickle()).map_err(|_| error("Account snapshot failed"))?;
        let state = State { v: 1, protocol: PROTOCOL.into(), name: self.name.clone(), device: self.device, registration: self.registration, identity: Base64::encode_string(&private), counter: self.counter, peers };
        private.zeroize();
        let result = serde_json::to_string(&state).map_err(|_| error("State snapshot failed"))?;
        if result.len() > MAX_STATE { return Err(error("State exceeds storage limit")); } Ok(result)
    }
    fn restore(name: String, device: u32, encoded: &str) -> Result<Self, JsValue> {
        if encoded.len() > MAX_STATE { return Err(error("State exceeds storage limit")); }
        let state: State = serde_json::from_str(encoded).map_err(|_| error("Invalid stored state"))?;
        if state.v != 1 || state.protocol != PROTOCOL || state.name != name || state.device != device || state.peers.len() > 4096 { return Err(error("Stored scope or protocol mismatch")); }
        let mut private = bytes(&state.identity, 256 * 1024)?;
        let result = Self::new(name, device, &private, state.registration); private.zeroize();
        let mut result = result?; result.counter = state.counter;
        let mut seen = std::collections::BTreeSet::new();
        for peer in state.peers {
            if !seen.insert((peer.name.clone(), peer.device)) { return Err(error("Duplicate stored peer")); }
            result.pin_identity(peer.name.clone(), peer.device, &bytes(&peer.identity, 64)?)?;
            if let Some(encoded) = peer.session {
                let sessions: Vec<SessionPickle> = serde_json::from_str(&encoded).map_err(|_| error("Invalid stored sessions"))?;
                if sessions.is_empty() || sessions.len() > 40 { return Err(error("Stored session limits exceeded")); }
                result.peers.last_mut().ok_or_else(|| error("Peer restore failed"))?.sessions = sessions.into_iter().map(Session::from_pickle).collect();
            }
        }
        Ok(result)
    }
}
#[wasm_bindgen]
impl RatchetDevice {
    #[wasm_bindgen(constructor)]
    pub fn new(name: String, device: u32, private: &[u8], registration: u32) -> Result<Self, JsValue> {
        address(&name, device)?;
        if !(1..16380).contains(&registration) { return Err(error("Invalid registration number")); }
        Ok(Self { name, device, registration, account: account(private)?, counter: 0, peers: Vec::new(), transaction: 0, checkpoint: None })
    }
    #[wasm_bindgen(js_name = pinIdentity)]
    pub fn pin_identity(&mut self, name: String, device: u32, identity: &[u8]) -> Result<(), JsValue> {
        address(&name, device)?; public_keys(identity)?;
        let encoded = Base64::encode_string(identity);
        if let Some(peer) = self.peers.iter().find(|peer| peer.name == name && peer.device == device) {
            if peer.identity != encoded { return Err(error("Identity changed: explicit verification required")); }
        } else {
            if self.peers.len() >= 4096 { return Err(error("Device peer capacity exceeded")); }
            self.peers.push(Peer { name, device, identity: encoded, sessions: Vec::new() });
        }
        Ok(())
    }
    #[wasm_bindgen(js_name = preKeyBundle)]
    pub fn pre_key_bundle(&mut self, _now: f64) -> Result<String, JsValue> {
        // Never let the vendor's bounded store discard a still-needed key.
        if self.account.stored_one_time_key_count() >= self.account.max_number_of_one_time_keys() { return Err(error("Pending private prekey capacity reached")); }
        let id = self.counter.checked_add(1).ok_or_else(|| error("Prekey identifiers exhausted"))?;
        self.account.generate_one_time_keys(1);
        let keys = self.account.one_time_keys();
        if keys.len() != 1 { return Err(error("Unexpected unpublished prekey state")); }
        let prekey = keys.values().next().ok_or_else(|| error("Prekey generation failed"))?;
        let mut bundle = Bundle { v: 1, suite: SUITE.into(), registration_id: self.registration, device_id: self.device, identity_key: Base64::encode_string(&public(&self.account)), pre_key_id: id,
            pre_key_public: Base64::encode_string(prekey.as_bytes()), signature: String::new() };
        bundle.signature = Base64::encode_string(&self.account.sign(bundle.signed_bytes()?).to_bytes());
        self.counter = id; self.account.mark_keys_as_published();
        serde_json::to_string(&bundle).map_err(|_| error("Prekey serialization failed"))
    }
    pub fn establish(&mut self, name: String, device: u32, encoded: String, _now: f64) -> Result<(), JsValue> {
        if encoded.len() > 4096 { return Err(error("Bundle exceeds size limit")); }
        let index = self.peer_index(&name, device)?;
        let bundle: Bundle = serde_json::from_str(&encoded).map_err(|_| error("Invalid prekey bundle"))?;
        if bundle.v != 1 || bundle.suite != SUITE || bundle.device_id != device || !(1..16380).contains(&bundle.registration_id) || bundle.pre_key_id == 0 || bundle.identity_key != self.peers[index].identity { return Err(error("Bundle identity or protocol mismatch")); }
        let (curve, signing) = public_keys(&bytes(&bundle.identity_key, 64)?)?;
        let signature = Ed25519Signature::from_slice(&bytes(&bundle.signature, 64)?).map_err(|_| error("Invalid prekey signature"))?;
        signing.verify(&bundle.signed_bytes()?, &signature).map_err(|_| error("Prekey signature rejected"))?;
        let prekey = Curve25519PublicKey::from_slice(&bytes(&bundle.pre_key_public, 32)?).map_err(|_| error("Invalid agreement prekey"))?;
        let session = self.account.create_outbound_session(SessionConfig::version_1(), curve, prekey).map_err(|_| error("Session establishment rejected"))?;
        self.peers[index].sessions.insert(0, session); self.peers[index].sessions.truncate(40); Ok(())
    }
    pub fn encrypt(&mut self, name: String, device: u32, plaintext: &[u8], _now: f64) -> Result<String, JsValue> {
        if plaintext.len() > 131072 { return Err(error("Key capsule exceeds limit")); }
        let index = self.peer_index(&name, device)?;
        let session = self.peers[index].sessions.first_mut().ok_or_else(|| error("No established session"))?;
        let message = session.encrypt(plaintext).map_err(|_| error("Ratchet encryption rejected"))?;
        let (kind, data) = message.to_parts();
        serde_json::to_string(&serde_json::json!({ "type": if kind == 0 {3} else {2}, "bytes": Base64::encode_string(&data) })).map_err(|_| error("Message serialization failed"))
    }
    pub fn decrypt(&mut self, name: String, device: u32, kind: u32, ciphertext: &[u8]) -> Result<Vec<u8>, JsValue> {
        if ciphertext.len() > 131072 || ![2,3].contains(&kind) { return Err(error("Unsupported message type or size")); }
        let index = self.peer_index(&name, device)?;
        let message = OlmMessage::from_parts(if kind == 3 {0} else {1}, ciphertext).map_err(|_| error("Invalid ratchet message"))?;
        for position in 0..self.peers[index].sessions.len() {
            let backup = self.peers[index].sessions[position].pickle();
            match self.peers[index].sessions[position].decrypt(&message) {
                Ok(plaintext) => { let active = self.peers[index].sessions.remove(position); self.peers[index].sessions.insert(0, active); return Ok(plaintext); },
                Err(_) => self.peers[index].sessions[position] = Session::from_pickle(backup),
            }
        }
        if let OlmMessage::PreKey(prekey) = message {
            let (curve, _) = public_keys(&bytes(&self.peers[index].identity, 64)?)?;
            let backup = self.account.pickle();
            match self.account.create_inbound_session(SessionConfig::version_1(), curve, &prekey) {
                Ok(created) => { self.peers[index].sessions.insert(0, created.session); self.peers[index].sessions.truncate(40); return Ok(created.plaintext); },
                Err(_) => self.account = Account::from_pickle(backup),
            }
        }
        Err(error("Ratchet decryption rejected"))
    }
    #[wasm_bindgen(js_name = exportPrivateStateForEncryption)]
    pub fn export_private_state(&self) -> Result<String, JsValue> { self.snapshot() }
    #[wasm_bindgen(js_name = restorePrivateState)]
    pub fn restore_private_state(name: String, device: u32, encoded: String) -> Result<Self, JsValue> { Self::restore(name, device, &encoded) }
    pub fn checkpoint(&mut self) -> Result<u32, JsValue> {
        if self.checkpoint.is_some() { return Err(error("A transaction is already open")); }
        let next = self.transaction.checked_add(1).ok_or_else(|| error("Transaction counter exhausted"))?;
        self.checkpoint = Some((next, Zeroizing::new(self.snapshot()?))); self.transaction = next; Ok(next)
    }
    pub fn commit(&mut self, token: u32) -> Result<(), JsValue> {
        if self.checkpoint.as_ref().map(|value| value.0) != Some(token) { return Err(error("Invalid transaction token")); }
        self.checkpoint = None; Ok(())
    }
    pub fn rollback(&mut self, token: u32) -> Result<(), JsValue> {
        if self.checkpoint.as_ref().map(|value| value.0) != Some(token) { return Err(error("Invalid transaction token")); }
        let (_, encoded) = self.checkpoint.take().ok_or_else(|| error("Missing transaction"))?;
        let restored = Self::restore(self.name.clone(), self.device, &encoded)?;
        self.account = restored.account; self.counter = restored.counter; self.peers = restored.peers; Ok(())
    }
}
