//! Laboratory session bridge. It stays in memory; browser/native persistence
//! and authenticated directory integration are separate activation gates.
use base64::{Engine, engine::general_purpose::STANDARD};
use libsignal_protocol::{
    DeviceId, GenericSignedPreKey, IdentityKey, IdentityKeyStore, InMemSignalProtocolStore,
    KeyPair, KyberPreKeyRecord, KyberPreKeyStore, PreKeyBundle, PreKeyRecord, PreKeySignalMessage,
    PreKeyStore, ProtocolAddress, PublicKey, SignalMessage, SignedPreKeyRecord, SignedPreKeyStore,
    Timestamp, kem, message_decrypt_prekey, message_decrypt_signal, message_encrypt, process_prekey_bundle,
};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use wasm_bindgen::prelude::*;
use super::{error, identity, rng};

const SUITE: &str = "NIVRA-LIBSIGNAL-BUNDLE-PILOT-1";
fn address(name: String, device: u32) -> Result<ProtocolAddress, JsValue> {
    if name.is_empty() || name.len() > 128 || !name.bytes().all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c)) {
        return Err(error("Invalid device address"));
    }
    Ok(ProtocolAddress::new(name, DeviceId::try_from(device).map_err(|_| error("Invalid device number"))?))
}
fn time(millis: f64) -> Result<(SystemTime, Timestamp), JsValue> {
    if !millis.is_finite() || millis < 0.0 || millis > 8_640_000_000_000_000.0 || millis.fract() != 0.0 {
        return Err(error("Invalid session timestamp"));
    }
    let millis = millis as u64;
    Ok((UNIX_EPOCH.checked_add(Duration::from_millis(millis)).ok_or_else(|| error("Timestamp overflow"))?, Timestamp::from_epoch_millis(millis)))
}
fn binary(value: &str, maximum: usize) -> Result<Vec<u8>, JsValue> {
    if value.len() > maximum.div_ceil(3) * 4 { return Err(error("Binary input exceeds limit")); }
    let bytes = STANDARD.decode(value).map_err(|_| error("Invalid binary encoding"))?;
    if bytes.len() > maximum { return Err(error("Binary input exceeds limit")); }
    Ok(bytes)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    v: u8, suite: String, registration_id: u32, device_id: u32, identity_key: String,
    pre_key_id: u32, pre_key_public: String, signed_pre_key_id: u32, signed_pre_key_public: String,
    signed_pre_key_signature: String, kyber_pre_key_id: u32, kyber_pre_key_public: String, kyber_pre_key_signature: String,
}
#[derive(Serialize)]
struct Encrypted { r#type: u8, bytes: String }
struct Checkpoint { token: u32, store: InMemSignalProtocolStore, counter: u32, peers: Vec<ProtocolAddress> }

#[wasm_bindgen]
pub struct RatchetDevice {
    address: ProtocolAddress,
    store: InMemSignalProtocolStore,
    registration: u32,
    device: u32,
    counter: u32,
    peers: Vec<ProtocolAddress>,
    checkpoint: Option<Checkpoint>,
    transaction: u32,
}
#[wasm_bindgen]
impl RatchetDevice {
    #[wasm_bindgen(constructor)]
    pub fn new(name: String, device: u32, private_identity: &[u8], registration: u32) -> Result<Self, JsValue> {
        if !(1..16380).contains(&registration) { return Err(error("Invalid registration number")); }
        Ok(Self { address: address(name, device)?, store: InMemSignalProtocolStore::new(identity(private_identity)?, registration)
            .map_err(|_| error("Store initialization failed"))?, registration, device, counter: 0,
            peers: Vec::new(), checkpoint: None, transaction: 0 })
    }
    #[wasm_bindgen(js_name = pinIdentity)]
    pub async fn pin_identity(&mut self, name: String, device: u32, public: &[u8]) -> Result<(), JsValue> {
        let peer = address(name, device)?;
        let public = IdentityKey::decode(public).map_err(|_| error("Invalid identity public key"))?;
        if let Some(previous) = self.store.identity_store.get_identity(&peer).await.map_err(|_| error("Identity lookup failed"))? {
            if previous != public { return Err(error("Identity changed: explicit re-verification required")); }
        } else {
            if self.peers.len() >= 512 { return Err(error("Pilot peer limit reached")); }
            self.store.identity_store.save_identity(&peer, &public).await.map_err(|_| error("Identity pin failed"))?;
            self.peers.push(peer);
        }
        Ok(())
    }
    #[wasm_bindgen(js_name = preKeyBundle)]
    pub async fn pre_key_bundle(&mut self, now: f64) -> Result<String, JsValue> {
        if self.counter >= 256 { return Err(error("Pilot prekey generation limit reached")); }
        let (_, timestamp) = time(now)?;
        let mut random = rng()?;
        let identity = self.store.identity_store.get_identity_key_pair().await.map_err(|_| error("Identity lookup failed"))?;
        let one_time = KeyPair::generate(&mut random);
        let signed = KeyPair::generate(&mut random);
        let kem = kem::KeyPair::generate(kem::KeyType::Kyber1024, &mut random);
        let signature = identity.private_key().calculate_signature(&signed.public_key.serialize(), &mut random).map_err(|_| error("Prekey signature failed"))?;
        let kem_signature = identity.private_key().calculate_signature(&kem.public_key.serialize(), &mut random).map_err(|_| error("PQ prekey signature failed"))?;
        self.counter += 1;
        let id = self.counter;
        self.store.pre_key_store.save_pre_key(id.into(), &PreKeyRecord::new(id.into(), &one_time)).await.map_err(|_| error("Prekey save failed"))?;
        self.store.signed_pre_key_store.save_signed_pre_key(id.into(), &SignedPreKeyRecord::new(id.into(), timestamp, &signed, &signature)).await.map_err(|_| error("Signed prekey save failed"))?;
        self.store.kyber_pre_key_store.save_kyber_pre_key(id.into(), &KyberPreKeyRecord::new(id.into(), timestamp, &kem, &kem_signature)).await.map_err(|_| error("PQ prekey save failed"))?;
        serde_json::to_string(&Bundle { v: 1, suite: SUITE.into(), registration_id: self.registration, device_id: self.device,
            identity_key: STANDARD.encode(identity.identity_key().serialize()), pre_key_id: id, pre_key_public: STANDARD.encode(one_time.public_key.serialize()),
            signed_pre_key_id: id, signed_pre_key_public: STANDARD.encode(signed.public_key.serialize()), signed_pre_key_signature: STANDARD.encode(signature),
            kyber_pre_key_id: id, kyber_pre_key_public: STANDARD.encode(kem.public_key.serialize()), kyber_pre_key_signature: STANDARD.encode(kem_signature) })
            .map_err(|_| error("Bundle encoding failed"))
    }
    pub async fn establish(&mut self, name: String, device: u32, encoded: String, now: f64) -> Result<(), JsValue> {
        let peer = address(name, device)?; let (now, _) = time(now)?;
        if encoded.len() > 16384 { return Err(error("Bundle exceeds limit")); }
        let bundle: Bundle = serde_json::from_str(&encoded).map_err(|_| error("Invalid bundle schema"))?;
        if bundle.v != 1 || bundle.suite != SUITE || bundle.device_id != device || !(1..16380).contains(&bundle.registration_id)
            || bundle.pre_key_id == 0 || bundle.signed_pre_key_id == 0 || bundle.kyber_pre_key_id == 0 {
            return Err(error("Incompatible prekey bundle"));
        }
        let identity = IdentityKey::decode(&binary(&bundle.identity_key, 33)?).map_err(|_| error("Invalid peer identity"))?;
        if self.store.identity_store.get_identity(&peer).await.map_err(|_| error("Identity lookup failed"))? != Some(identity) {
            return Err(error("Peer identity has not been explicitly pinned"));
        }
        let bundle = PreKeyBundle::new(bundle.registration_id, DeviceId::try_from(device).map_err(|_| error("Invalid device"))?,
            Some((bundle.pre_key_id.into(), PublicKey::deserialize(&binary(&bundle.pre_key_public, 33)?).map_err(|_| error("Invalid prekey"))?)),
            bundle.signed_pre_key_id.into(), PublicKey::deserialize(&binary(&bundle.signed_pre_key_public, 33)?).map_err(|_| error("Invalid signed prekey"))?, binary(&bundle.signed_pre_key_signature, 64)?,
            bundle.kyber_pre_key_id.into(), kem::PublicKey::deserialize(&binary(&bundle.kyber_pre_key_public, 4096)?).map_err(|_| error("Invalid PQ prekey"))?, binary(&bundle.kyber_pre_key_signature, 64)?, identity)
            .map_err(|_| error("Bundle validation failed"))?;
        let snapshot = self.store.clone();
        let result = process_prekey_bundle(&peer, &self.address, &mut self.store.session_store, &mut self.store.identity_store, &bundle, now, &mut rng()?).await;
        if result.is_err() { self.store = snapshot; }
        result.map_err(|_| error("Session establishment rejected"))
    }
    pub async fn encrypt(&mut self, name: String, device: u32, plaintext: &[u8], now: f64) -> Result<String, JsValue> {
        let peer = address(name, device)?; let (now, _) = time(now)?;
        if plaintext.len() > 131072 { return Err(error("Capsule exceeds limit")); }
        if self.store.identity_store.get_identity(&peer).await.map_err(|_| error("Identity lookup failed"))?.is_none() { return Err(error("Unpinned peer")); }
        let snapshot = self.store.clone();
        let result = message_encrypt(plaintext, &peer, &self.address, &mut self.store.session_store, &mut self.store.identity_store, now, &mut rng()?).await;
        match result {
            Ok(message) => serde_json::to_string(&Encrypted { r#type: message.message_type() as u8, bytes: STANDARD.encode(message.serialize()) }).map_err(|_| error("Message encoding failed")),
            Err(_) => { self.store = snapshot; Err(error("Ratchet encryption rejected")) }
        }
    }
    pub async fn decrypt(&mut self, name: String, device: u32, kind: u32, ciphertext: &[u8]) -> Result<Vec<u8>, JsValue> {
        let peer = address(name, device)?;
        if ciphertext.len() > 131072 { return Err(error("Ciphertext exceeds limit")); }
        if self.store.identity_store.get_identity(&peer).await.map_err(|_| error("Identity lookup failed"))?.is_none() { return Err(error("Unpinned peer")); }
        let snapshot = self.store.clone(); let mut random = rng()?;
        let result = match kind {
            3 => {
                let message = PreKeySignalMessage::try_from(ciphertext).map_err(|_| error("Invalid prekey message"))?;
                message_decrypt_prekey(&message, &peer, &self.address, &mut self.store.session_store, &mut self.store.identity_store,
                    &mut self.store.pre_key_store, &self.store.signed_pre_key_store, &mut self.store.kyber_pre_key_store, &mut random).await.map(|result| result.plaintext)
            },
            2 => {
                let message = SignalMessage::try_from(ciphertext).map_err(|_| error("Invalid ratchet message"))?;
                message_decrypt_signal(&message, &peer, &self.address, &mut self.store.session_store, &mut self.store.identity_store, &mut random).await
            },
            _ => return Err(error("Unsupported message type: no legacy fallback")),
        };
        if result.is_err() { self.store = snapshot; }
        result.map_err(|_| error("Ratchet decryption rejected"))
    }
    /// A caller serializes operations and verifies its outer AES-GCM payload
    /// before committing. Persistence/CAS is not implemented by this memory probe.
    pub fn checkpoint(&mut self) -> Result<u32, JsValue> {
        if self.checkpoint.is_some() { return Err(error("A transaction is already active")); }
        self.transaction = self.transaction.checked_add(1).ok_or_else(|| error("Transaction counter exhausted"))?;
        self.checkpoint = Some(Checkpoint { token: self.transaction, store: self.store.clone(), counter: self.counter, peers: self.peers.clone() });
        Ok(self.transaction)
    }
    pub fn commit(&mut self, token: u32) -> Result<(), JsValue> {
        if self.checkpoint.as_ref().map(|value| value.token) != Some(token) { return Err(error("Wrong transaction token")); }
        self.checkpoint = None; Ok(())
    }
    pub fn rollback(&mut self, token: u32) -> Result<(), JsValue> {
        if self.checkpoint.as_ref().map(|value| value.token) != Some(token) { return Err(error("Wrong transaction token")); }
        let snapshot = self.checkpoint.take().ok_or_else(|| error("No active transaction"))?;
        self.store = snapshot.store; self.counter = snapshot.counter; self.peers = snapshot.peers; Ok(())
    }
}
