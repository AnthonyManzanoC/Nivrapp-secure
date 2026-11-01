use super::*;
use libsignal_protocol::{SessionRecord, SessionStore};
use std::collections::BTreeSet;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Peer { name: String, device: u32, identity: String, session: Option<String> }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    v: u8, name: String, device: u32, registration: u32, identity: String, counter: u32,
    peers: Vec<Peer>, prekeys: Vec<(u32, String)>, signed: Vec<(u32, String)>, kyber: Vec<(u32, String)>, used: Vec<kyber::UsedKey>,
}
fn check_ids(rows: &[(u32, String)], counter: u32) -> Result<(), JsValue> {
    let mut ids = BTreeSet::new();
    for (id, _) in rows {
        if *id == 0 || *id > counter || !ids.insert(*id) { return Err(error("Invalid or duplicate stored prekey id")); }
    }
    Ok(())
}
#[wasm_bindgen]
impl RatchetDevice {
    /// Contains PRIVATE keys. Encrypt the entire result before persistence.
    /// Snapshotting during an outer transaction is intentional: that candidate
    /// state must commit atomically with its exact encrypted retry envelope.
    #[wasm_bindgen(js_name = exportPrivateStateForEncryption)]
    pub async fn export_private_state(&self) -> Result<String, JsValue> {
        let identity = self.store.identity_store.get_identity_key_pair().await.map_err(|_| error("Identity export failed"))?;
        let mut peers = Vec::new();
        for peer in &self.peers {
            let identity = self.store.identity_store.get_identity(peer).await.map_err(|_| error("Identity export failed"))?.ok_or_else(|| error("Missing pinned identity"))?;
            let session = self.store.session_store.load_session(peer).await.map_err(|_| error("Session export failed"))?
                .map(|record| record.serialize().map(|bytes| STANDARD.encode(bytes))).transpose().map_err(|_| error("Session serialization failed"))?;
            peers.push(Peer { name: peer.name().into(), device: peer.device_id().into(), identity: STANDARD.encode(identity.serialize()), session });
        }
        let mut state = State { v: 1, name: self.address.name().into(), device: self.device, registration: self.registration,
            identity: STANDARD.encode(identity.serialize()), counter: self.counter, peers, prekeys: Vec::new(), signed: Vec::new(), kyber: Vec::new(), used: self.kyber.used.clone() };
        for id in self.store.all_pre_key_ids() {
            state.prekeys.push(((*id).into(), STANDARD.encode(self.store.pre_key_store.get_pre_key(*id).await.map_err(|_| error("Prekey export failed"))?.serialize().map_err(|_| error("Prekey serialization failed"))?)));
        }
        for id in self.store.all_signed_pre_key_ids() {
            state.signed.push(((*id).into(), STANDARD.encode(self.store.signed_pre_key_store.get_signed_pre_key(*id).await.map_err(|_| error("Signed prekey export failed"))?.serialize().map_err(|_| error("Signed prekey serialization failed"))?)));
        }
        for id in self.kyber.inner.all_kyber_pre_key_ids() {
            state.kyber.push(((*id).into(), STANDARD.encode(self.kyber.get_kyber_pre_key(*id).await.map_err(|_| error("PQ prekey export failed"))?.serialize().map_err(|_| error("PQ prekey serialization failed"))?)));
        }
        state.prekeys.sort_by_key(|(id, _)| *id); state.signed.sort_by_key(|(id, _)| *id); state.kyber.sort_by_key(|(id, _)| *id);
        let encoded = serde_json::to_string(&state).map_err(|_| error("State serialization failed"))?;
        if encoded.len() > 32 * 1024 * 1024 { return Err(error("State exceeds pilot storage limit")); }
        Ok(encoded)
    }

    #[wasm_bindgen(js_name = restorePrivateState)]
    pub async fn restore_private_state(name: String, device: u32, encoded: String) -> Result<RatchetDevice, JsValue> {
        if encoded.len() > 32 * 1024 * 1024 { return Err(error("State exceeds pilot storage limit")); }
        let state: State = serde_json::from_str(&encoded).map_err(|_| error("Invalid stored state schema"))?;
        if state.v != 1 || state.name != name || state.device != device || state.counter > 256
            || state.peers.len() > 512 || state.prekeys.len() > 256 || state.signed.len() > 256 || state.kyber.len() > 256 || state.used.len() > 4096 {
            return Err(error("Stored state scope or limits mismatch"));
        }
        check_ids(&state.prekeys, state.counter)?; check_ids(&state.signed, state.counter)?; check_ids(&state.kyber, state.counter)?;
        let mut result = RatchetDevice::new(name, device, &binary(&state.identity, 1024)?, state.registration)?;
        result.counter = state.counter;
        let mut seen_peers = BTreeSet::new();
        for peer in state.peers {
            if !seen_peers.insert((peer.name.clone(), peer.device)) { return Err(error("Duplicate stored peer")); }
            let address = address(peer.name, peer.device)?;
            let public = IdentityKey::decode(&binary(&peer.identity, 33)?).map_err(|_| error("Invalid stored identity"))?;
            result.store.identity_store.save_identity(&address, &public).await.map_err(|_| error("Identity restore failed"))?;
            if let Some(encoded) = peer.session {
                let record = SessionRecord::deserialize(&binary(&encoded, 2 * 1024 * 1024)?).map_err(|_| error("Invalid stored session"))?;
                result.store.session_store.store_session(&address, &record).await.map_err(|_| error("Session restore failed"))?;
            }
            result.peers.push(address);
        }
        for (id, encoded) in state.prekeys {
            let record = PreKeyRecord::deserialize(&binary(&encoded, 1024)?).map_err(|_| error("Invalid stored prekey"))?;
            if record.id().map_err(|_| error("Invalid stored prekey id"))? != id.into() { return Err(error("Stored prekey id mismatch")); }
            record.key_pair().map_err(|_| error("Invalid stored prekey pair"))?;
            result.store.pre_key_store.save_pre_key(id.into(), &record).await.map_err(|_| error("Prekey restore failed"))?;
        }
        for (id, encoded) in state.signed {
            let record = SignedPreKeyRecord::deserialize(&binary(&encoded, 2048)?).map_err(|_| error("Invalid stored signed prekey"))?;
            if record.id().map_err(|_| error("Invalid stored signed prekey id"))? != id.into() { return Err(error("Stored signed prekey id mismatch")); }
            record.key_pair().map_err(|_| error("Invalid stored signed prekey pair"))?;
            result.store.signed_pre_key_store.save_signed_pre_key(id.into(), &record).await.map_err(|_| error("Signed prekey restore failed"))?;
        }
        for (id, encoded) in state.kyber {
            let record = KyberPreKeyRecord::deserialize(&binary(&encoded, 16384)?).map_err(|_| error("Invalid stored PQ prekey"))?;
            if record.id().map_err(|_| error("Invalid stored PQ prekey id"))? != id.into() { return Err(error("Stored PQ prekey id mismatch")); }
            record.key_pair().map_err(|_| error("Invalid stored PQ prekey pair"))?;
            result.kyber.save_kyber_pre_key(id.into(), &record).await.map_err(|_| error("PQ prekey restore failed"))?;
        }
        for used in state.used {
            if used.kyber == 0 || used.kyber > state.counter || used.signed == 0 || used.signed > state.counter { return Err(error("Invalid stored replay gate id")); }
            let base = PublicKey::deserialize(&binary(&used.base, 33)?).map_err(|_| error("Invalid stored base key"))?;
            result.kyber.mark_kyber_pre_key_used(used.kyber.into(), used.signed.into(), &base).await.map_err(|_| error("Invalid stored replay gate"))?;
        }
        Ok(result)
    }
}
