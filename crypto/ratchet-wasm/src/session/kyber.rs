use super::*;
use async_trait::async_trait;
use libsignal_protocol::{InMemKyberPreKeyStore, KyberPreKeyId, SignedPreKeyId, SignalProtocolError};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UsedKey { pub kyber: u32, pub signed: u32, pub base: String }

/// Preserve the upstream replay gate as well as its records across snapshots.
#[derive(Clone, Default)]
pub(super) struct TrackedKyber {
    pub inner: InMemKyberPreKeyStore,
    pub used: Vec<UsedKey>,
}
#[async_trait(?Send)]
impl KyberPreKeyStore for TrackedKyber {
    async fn get_kyber_pre_key(&self, id: KyberPreKeyId) -> libsignal_protocol::error::Result<KyberPreKeyRecord> {
        self.inner.get_kyber_pre_key(id).await
    }
    async fn save_kyber_pre_key(&mut self, id: KyberPreKeyId, record: &KyberPreKeyRecord) -> libsignal_protocol::error::Result<()> {
        self.inner.save_kyber_pre_key(id, record).await
    }
    async fn mark_kyber_pre_key_used(&mut self, id: KyberPreKeyId, signed: SignedPreKeyId, base: &PublicKey) -> libsignal_protocol::error::Result<()> {
        if self.used.len() >= 4096 { return Err(SignalProtocolError::InvalidArgument("Pilot replay gate limit reached".into())); }
        self.inner.mark_kyber_pre_key_used(id, signed, base).await?;
        self.used.push(UsedKey { kyber: id.into(), signed: signed.into(), base: STANDARD.encode(base.serialize()) });
        Ok(())
    }
}
