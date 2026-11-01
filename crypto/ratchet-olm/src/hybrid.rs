//! Nivra authenticated 4DH + ML-KEM-768 initial agreement. The subsequent
//! Double Ratchet remains vodozemac's implementation. This is a Nivra wire
//! protocol, not the Signal PQXDH wire format.
use base64ct::{Base64, Encoding};
use hkdf::Hkdf;
use ml_kem::{MlKem768, Decapsulate, KeyExport};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use vodozemac::{Curve25519PublicKey as Public, Curve25519SecretKey as Secret, Ed25519PublicKey, Ed25519Signature};
use vodozemac::olm::{Account, AccountPickle, Session, SessionConfig, SessionKeys, SessionPickle, OlmMessage};
use zeroize::{Zeroize, Zeroizing};
pub const PROTOCOL: &str = "NIVRA-PQXDH-MLKEM768-A256GCM-1";
pub const BUNDLE: &str = "NIVRA-PQXDH-MLKEM768-BUNDLE-1";
pub type Result<T> = std::result::Result<T, String>;
fn fail(value: &str) -> String { value.into() }
pub fn binary(value: &str, maximum: usize) -> Result<Vec<u8>> {
    if value.len() > maximum.div_ceil(3) * 4 { return Err(fail("Binary size exceeds limit")); }
    let bytes = Base64::decode_vec(value).map_err(|_| fail("Invalid binary encoding"))?;
    if bytes.len() > maximum || Base64::encode_string(&bytes) != value { return Err(fail("Invalid canonical encoding")); } Ok(bytes)
}
fn exact(value: &str, count: usize) -> Result<Vec<u8>> { let bytes = binary(value, count)?; if bytes.len() != count { return Err(fail("Invalid binary length")); } Ok(bytes) }
fn curve(value: &str) -> Result<Public> { Public::from_slice(&exact(value, 32)?).map_err(|_| fail("Invalid agreement key")) }
fn address(name: &str, device: u32) -> Result<()> {
    if device != 1 || name.is_empty() || name.len() > 128 || !name.bytes().all(|value| value.is_ascii_alphanumeric() || b"_-".contains(&value)) { return Err(fail("Invalid device address")); } Ok(())
}
fn public(account: &Account, agreement: &Secret) -> Vec<u8> {
    [Public::from(agreement).as_bytes().as_slice(), account.ed25519_key().as_bytes().as_slice()].concat()
}
pub fn public_parts(bytes: &[u8]) -> Result<(Public, Ed25519PublicKey)> {
    if bytes.len() != 64 { return Err(fail("Invalid public identity")); }
    Ok((Public::from_slice(&bytes[..32]).map_err(|_| fail("Invalid agreement key"))?,
        Ed25519PublicKey::from_slice(bytes[32..].try_into().map_err(|_| fail("Invalid signing key length"))?).map_err(|_| fail("Invalid signing key"))?))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrivateIdentity { v: u8, account: AccountPickle, agreement: Secret }
fn identity(bytes: &[u8]) -> Result<PrivateIdentity> {
    if bytes.len() > 256 * 1024 { return Err(fail("Private identity exceeds limit")); }
    let value: PrivateIdentity = serde_json::from_slice(bytes).map_err(|_| fail("Invalid private identity"))?;
    if value.v != 1 { return Err(fail("Unsupported private identity")); } Ok(value)
}
pub fn create_identity() -> Result<Vec<u8>> {
    serde_json::to_vec(&PrivateIdentity { v: 1, account: Account::new().pickle(), agreement: Secret::new() }).map_err(|_| fail("Identity generation failed"))
}
pub fn identity_public(bytes: &[u8]) -> Result<Vec<u8>> { let own = identity(bytes)?; Ok(public(&Account::from_pickle(own.account), &own.agreement)) }
pub fn sign_identity(bytes: &[u8], message: &[u8]) -> Result<Vec<u8>> {
    if message.len() > 131072 { return Err(fail("Signature input exceeds limit")); }
    Ok(Account::from_pickle(identity(bytes)?.account).sign(message).to_bytes().to_vec())
}
pub fn verify_identity(public: &[u8], message: &[u8], signature: &[u8]) -> Result<bool> {
    if message.len() > 131072 || signature.len() != 64 { return Err(fail("Invalid signature input")); }
    Ok(public_parts(public)?.1.verify(message, &Ed25519Signature::from_slice(signature).map_err(|_| fail("Invalid signature"))?).is_ok())
}
/// Deterministic cross-implementation test adapter. Inputs are caller-supplied
/// synthetic seeds; this never reads or changes a device's private state.
pub fn ml_kem_vector(seed: &[u8], entropy: &[u8]) -> Result<String> {
    if seed.len()!=64||entropy.len()!=32{return Err(fail("Invalid vector inputs"));}
    let seed=ml_kem::Seed::try_from(seed).map_err(|_|fail("Invalid vector seed"))?;
    let dk=ml_kem::DecapsulationKey::<MlKem768>::from_seed(seed);
    let message=ml_kem::B32::try_from(entropy).map_err(|_|fail("Invalid vector entropy"))?;
    let(ct,mut shared)=dk.encapsulation_key().encapsulate_deterministic(&message);
    let mut recovered=dk.decapsulate(&ct);
    if shared!=recovered{return Err(fail("ML-KEM round trip failed"));}
    let value=serde_json::json!({"publicKey":Base64::encode_string(&dk.encapsulation_key().to_bytes()),"cipherText":Base64::encode_string(&ct),"sharedSecret":Base64::encode_string(&shared)});
    shared.as_mut_slice().zeroize();recovered.as_mut_slice().zeroize();serde_json::to_string(&value).map_err(|_|fail("Vector encoding failed"))
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bundle { pub v: u8, pub suite: String, pub registration_id: u32, pub device_id: u32, pub identity_key: String,
    pub pre_key_id: u32, pub signed_pre_key_public: String, pub pre_key_public: String, pub ml_kem_public: String, pub signature: String }
impl Bundle {
    fn signed_bytes(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(&(self.v, &self.suite, self.registration_id, self.device_id, &self.identity_key, self.pre_key_id, &self.signed_pre_key_public, &self.pre_key_public, &self.ml_kem_public)).map_err(|_| fail("Bundle encoding failed"))
    }
    fn validate(&self) -> Result<()> {
        if self.v != 1 || self.suite != BUNDLE || self.device_id != 1 || !(1..16380).contains(&self.registration_id) || self.pre_key_id == 0 { return Err(fail("Invalid prekey protocol")); }
        let identity = exact(&self.identity_key, 64)?; curve(&self.signed_pre_key_public)?; curve(&self.pre_key_public)?; exact(&self.ml_kem_public, 1184)?;
        if !verify_identity(&identity, &self.signed_bytes()?, &exact(&self.signature, 64)?)? { return Err(fail("Prekey signature rejected")); } Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pair()->(Engine,Engine){
        let a=create_identity().unwrap();let b=create_identity().unwrap();
        let mut alice=Engine::new("alice".into(),1,&a,1).unwrap();let mut bob=Engine::new("bob".into(),1,&b,2).unwrap();
        alice.pin("bob".into(),1,&identity_public(&b).unwrap()).unwrap();bob.pin("alice".into(),1,&identity_public(&a).unwrap()).unwrap();(alice,bob)
    }
    fn packet(value:String)->(u32,Vec<u8>){let value:serde_json::Value=serde_json::from_str(&value).unwrap();(value["type"].as_u64().unwrap()as u32,binary(value["bytes"].as_str().unwrap(),131072).unwrap())}
    #[test]
    fn external_root_roles_exchange_without_sharing_sender_ratchet_private_key(){
        let private=Secret::new();let keys=SessionKeys{identity_key:Public::from(&Secret::new()),base_key:Public::from(&Secret::new()),one_time_key:Public::from(&Secret::new())};
        let mut secret=private.to_bytes();let mut alice=Session::from_root_key_material(SessionConfig::version_1(),keys,[7;32],[8;32],*secret);secret.zeroize();
        let mut bob=Session::from_root_key_material_receiver(SessionConfig::version_1(),keys,[7;32],[8;32],Public::from(&private));
        assert!(alice.active_sending_state().is_some());assert!(bob.active_sending_state().is_none());
        for turn in 0..8{let text=format!("role-{turn}");if turn%2==0{let message=alice.encrypt(text.as_bytes()).unwrap();assert_eq!(bob.decrypt(&message).unwrap(),text.as_bytes());}else{let message=bob.encrypt(text.as_bytes()).unwrap();assert_eq!(alice.decrypt(&message).unwrap(),text.as_bytes());}}
    }
    #[test]
    fn hybrid_turns_and_encrypted_state_contract_survive_restore(){
        let(mut alice,mut bob)=pair();alice.establish("bob".into(),1,&bob.bundle().unwrap()).unwrap();
        for turn in 0..8{let text=format!("turn-{turn}");if turn%2==0{let(kind,cipher)=packet(alice.encrypt("bob".into(),1,text.as_bytes()).unwrap());assert_eq!(bob.decrypt("alice".into(),1,kind,&cipher).unwrap(),text.as_bytes());}else{let(kind,cipher)=packet(bob.encrypt("alice".into(),1,text.as_bytes()).unwrap());assert_eq!(alice.decrypt("bob".into(),1,kind,&cipher).unwrap(),text.as_bytes());}
            alice=Engine::restore("alice".into(),1,&alice.snapshot().unwrap()).unwrap();bob=Engine::restore("bob".into(),1,&bob.snapshot().unwrap()).unwrap();}
        assert_eq!(bob.prekeys.len(),0);assert_eq!(bob.consumed(),vec![1]);bob.acknowledge_consumed(&[1]);assert!(bob.consumed().is_empty());
    }
    #[test]
    fn simultaneous_sessions_and_out_of_order_messages_reject_replay(){
        let(mut alice,mut bob)=pair();alice.establish("bob".into(),1,&bob.bundle().unwrap()).unwrap();bob.establish("alice".into(),1,&alice.bundle().unwrap()).unwrap();
        let(ka,ca)=packet(alice.encrypt("bob".into(),1,b"a").unwrap());let(kb,cb)=packet(bob.encrypt("alice".into(),1,b"b").unwrap());
        assert_eq!(alice.decrypt("bob".into(),1,kb,&cb).unwrap(),b"b");assert_eq!(bob.decrypt("alice".into(),1,ka,&ca).unwrap(),b"a");
        let packets=(0..5).map(|i|packet(alice.encrypt("bob".into(),1,&[i]).unwrap())).collect::<Vec<_>>();
        for i in [3,0,4,1,2]{assert_eq!(bob.decrypt("alice".into(),1,packets[i].0,&packets[i].1).unwrap(),[i as u8]);}
        assert!(bob.decrypt("alice".into(),1,packets[3].0,&packets[3].1).is_err());
    }
    #[test]
    fn hybrid_signature_tampering_cannot_consume_private_prekeys(){
        let(mut alice,mut bob)=pair();alice.establish("bob".into(),1,&bob.bundle().unwrap()).unwrap();let(kind,cipher)=packet(alice.encrypt("bob".into(),1,b"valid").unwrap());
        let mut altered:Packet=serde_json::from_slice(&cipher).unwrap();let initial=altered.initial.as_mut().unwrap();let mut ct=exact(&initial.body.kem_ciphertext,1088).unwrap();ct[0]^=1;initial.body.kem_ciphertext=Base64::encode_string(&ct);
        assert!(bob.decrypt("alice".into(),1,kind,&serde_json::to_vec(&altered).unwrap()).is_err());assert_eq!(bob.prekeys.len(),1);assert_eq!(bob.decrypt("alice".into(),1,kind,&cipher).unwrap(),b"valid");
    }
    #[test]
    fn initial_aead_failure_preserves_private_keys_and_accepts_valid_retry(){
        let(mut alice,mut bob)=pair();alice.establish("bob".into(),1,&bob.bundle().unwrap()).unwrap();let(kind,cipher)=packet(alice.encrypt("bob".into(),1,b"valid").unwrap());
        let mut altered:Packet=serde_json::from_slice(&cipher).unwrap();let mut olm=binary(&altered.olm,131072).unwrap();let last=olm.len()-1;olm[last]^=1;altered.olm=Base64::encode_string(&olm);
        assert!(bob.decrypt("alice".into(),1,kind,&serde_json::to_vec(&altered).unwrap()).is_err());assert_eq!(bob.prekeys.len(),1);assert_eq!(bob.decrypt("alice".into(),1,kind,&cipher).unwrap(),b"valid");
    }
    #[test]
    fn both_classical_and_post_quantum_inputs_and_transcript_change_the_root(){
        let base=root_material(&[1;128],&[2;32],b"context").unwrap();assert_ne!(*base,*root_material(&[3;128],&[2;32],b"context").unwrap());assert_ne!(*base,*root_material(&[1;128],&[4;32],b"context").unwrap());assert_ne!(*base,*root_material(&[1;128],&[2;32],b"other").unwrap());
        assert!(root_material(&[1;32],&[2;32],b"context").is_err());
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrivatePrekey { id: u32, signed: Secret, one_time: Secret, kem_seed: Vec<u8>, bundle: Bundle }
impl Drop for PrivatePrekey { fn drop(&mut self) { self.kem_seed.zeroize(); } }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitialBody { v: u8, suite: String, from: String, to: String, from_identity: String, from_registration: u32, bundle: Bundle, ephemeral: String, ratchet: String, kem_ciphertext: String }
impl InitialBody { fn bytes(&self) -> Result<Vec<u8>> { serde_json::to_vec(self).map_err(|_| fail("Handshake encoding failed")) } }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Initiation { body: InitialBody, signature: String }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Packet { v: u8, suite: String, olm: String, initial: Option<Initiation> }
struct LiveSession { session: Session, initial: Option<Initiation> }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedSession { session: SessionPickle, initial: Option<Initiation> }
struct Peer { name: String, device: u32, identity: String, sessions: Vec<LiveSession> }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SavedPeer { name: String, device: u32, identity: String, session: Option<String> }
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State { v: u8, protocol: String, name: String, device: u32, registration: u32, identity: String, counter: u32, peers: Vec<SavedPeer>, prekeys: Vec<PrivatePrekey>, consumed: Vec<u32> }
pub struct Engine { name: String, device: u32, registration: u32, account: Account, agreement: Secret, counter: u32, peers: Vec<Peer>, prekeys: Vec<PrivatePrekey>, consumed: Vec<u32> }
fn dh(secret: &Secret, public: &Public, output: &mut Vec<u8>) -> Result<()> {
    let shared = secret.diffie_hellman(public).ok_or_else(|| fail("Non-contributory agreement rejected"))?; output.extend_from_slice(shared.as_bytes()); Ok(())
}
fn root_material(classical: &[u8], pq: &[u8], transcript: &[u8]) -> Result<Zeroizing<[u8; 64]>> {
    if classical.len() != 128 || pq.len() != 32 { return Err(fail("Invalid hybrid input")); }
    let mut input = Zeroizing::new(vec![0xff; 32]); input.extend_from_slice(classical); input.extend_from_slice(pq);
    let mut info = b"NIVRA-HYBRID-PQXDH-MLKEM768-V1".to_vec(); info.extend_from_slice(&Sha256::digest(transcript));
    let mut output = Zeroizing::new([0u8; 64]);
    Hkdf::<Sha256>::new(Some(&[0u8; 32]), &input).expand(&info, output.as_mut()).map_err(|_| fail("Hybrid derivation failed"))?; Ok(output)
}
fn session_keys(body: &InitialBody) -> Result<SessionKeys> {
    Ok(SessionKeys { identity_key: public_parts(&exact(&body.from_identity, 64)?)?.0, base_key: curve(&body.ephemeral)?, one_time_key: curve(&body.bundle.pre_key_public)? })
}
impl Engine {
    pub fn new(name: String, device: u32, private: &[u8], registration: u32) -> Result<Self> {
        address(&name, device)?; if !(1..16380).contains(&registration) { return Err(fail("Invalid registration")); }
        let private = identity(private)?;
        Ok(Self { name, device, registration, account: Account::from_pickle(private.account), agreement: private.agreement, counter: 0, peers: Vec::new(), prekeys: Vec::new(), consumed: Vec::new() })
    }
    fn peer(&self, name: &str, device: u32) -> Result<usize> { address(name, device)?; self.peers.iter().position(|peer| peer.name == name && peer.device == device).ok_or_else(|| fail("Unpinned peer")) }
    pub fn pin(&mut self, name: String, device: u32, identity: &[u8]) -> Result<()> {
        address(&name, device)?; public_parts(identity)?; let encoded = Base64::encode_string(identity);
        if let Some(peer) = self.peers.iter().find(|peer| peer.name == name && peer.device == device) { if peer.identity != encoded { return Err(fail("Identity changed: explicit verification required")); } }
        else { if self.peers.len() >= 4096 { return Err(fail("Device peer capacity exceeded")); } self.peers.push(Peer { name, device, identity: encoded, sessions: Vec::new() }); } Ok(())
    }
    pub fn bundle(&mut self) -> Result<String> {
        if self.prekeys.len() >= 2048 { return Err(fail("Pending private prekey capacity reached")); }
        let id = self.counter.checked_add(1).ok_or_else(|| fail("Prekey identifiers exhausted"))?;
        let signed = Secret::new(); let one_time = Secret::new(); let mut seed = vec![0u8; 64]; getrandom::fill(&mut seed).map_err(|_| fail("Secure randomness unavailable"))?;
        let seed_array = ml_kem::Seed::try_from(seed.as_slice()).map_err(|_| fail("Invalid KEM seed"))?;
        let dk = ml_kem::DecapsulationKey::<MlKem768>::from_seed(seed_array);
        let mut bundle = Bundle { v: 1, suite: BUNDLE.into(), registration_id: self.registration, device_id: self.device, identity_key: Base64::encode_string(&public(&self.account, &self.agreement)), pre_key_id: id,
            signed_pre_key_public: Base64::encode_string(Public::from(&signed).as_bytes()), pre_key_public: Base64::encode_string(Public::from(&one_time).as_bytes()), ml_kem_public: Base64::encode_string(&dk.encapsulation_key().to_bytes()), signature: String::new() };
        bundle.signature = Base64::encode_string(&self.account.sign(bundle.signed_bytes()?).to_bytes());
        let encoded = serde_json::to_string(&bundle).map_err(|_| fail("Bundle serialization failed"))?;
        self.prekeys.push(PrivatePrekey { id, signed, one_time, kem_seed: seed, bundle }); self.counter = id; Ok(encoded)
    }
    pub fn establish(&mut self, name: String, device: u32, encoded: &str) -> Result<()> {
        if encoded.len() > 8192 { return Err(fail("Bundle exceeds limit")); } let index = self.peer(&name, device)?;
        let bundle: Bundle = serde_json::from_str(encoded).map_err(|_| fail("Invalid bundle schema"))?; bundle.validate()?;
        if bundle.identity_key != self.peers[index].identity { return Err(fail("Bundle identity mismatch")); }
        let remote = public_parts(&exact(&bundle.identity_key, 64)?)?.0; let signed = curve(&bundle.signed_pre_key_public)?; let one_time = curve(&bundle.pre_key_public)?;
        let ephemeral = Secret::new(); let ratchet = Secret::new(); let mut classical = Zeroizing::new(Vec::with_capacity(128));
        dh(&self.agreement, &signed, &mut classical)?; dh(&ephemeral, &remote, &mut classical)?; dh(&ephemeral, &signed, &mut classical)?; dh(&ephemeral, &one_time, &mut classical)?;
        let key_bytes = exact(&bundle.ml_kem_public, 1184)?;
        let kem_key = ml_kem::kem::Key::<ml_kem::EncapsulationKey<MlKem768>>::try_from(key_bytes.as_slice()).map_err(|_| fail("Invalid KEM public key length"))?;
        let kem = ml_kem::EncapsulationKey::<MlKem768>::new(&kem_key).map_err(|_| fail("Invalid KEM public key"))?;
        let mut entropy = [0u8; 32]; getrandom::fill(&mut entropy).map_err(|_| fail("Secure randomness unavailable"))?;
        let (ct, mut shared) = kem.encapsulate_deterministic(&entropy.into()); entropy.zeroize();
        let body = InitialBody { v: 1, suite: PROTOCOL.into(), from: self.name.clone(), to: name, from_identity: Base64::encode_string(&public(&self.account, &self.agreement)), from_registration: self.registration,
            bundle, ephemeral: Base64::encode_string(Public::from(&ephemeral).as_bytes()), ratchet: Base64::encode_string(Public::from(&ratchet).as_bytes()), kem_ciphertext: Base64::encode_string(&ct) };
        let transcript = body.bytes()?; let material = root_material(&classical, &shared, &transcript); shared.as_mut_slice().zeroize(); let material = material?;
        let mut secret = ratchet.to_bytes();
        let session = Session::from_root_key_material(SessionConfig::version_1(), session_keys(&body)?, material[..32].try_into().map_err(|_| fail("Root length"))?, material[32..].try_into().map_err(|_| fail("Chain length"))?, *secret); secret.zeroize();
        let initial = Initiation { signature: Base64::encode_string(&self.account.sign(&transcript).to_bytes()), body };
        self.peers[index].sessions.insert(0, LiveSession { session, initial: Some(initial) }); self.peers[index].sessions.truncate(40); Ok(())
    }
    pub fn encrypt(&mut self, name: String, device: u32, plaintext: &[u8]) -> Result<String> {
        if plaintext.len() > 131072 { return Err(fail("Key capsule exceeds limit")); } let index = self.peer(&name, device)?;
        let live = self.peers[index].sessions.first_mut().ok_or_else(|| fail("No established session"))?;
        let message = live.session.encrypt(plaintext).map_err(|_| fail("Ratchet encryption rejected"))?; let (kind, bytes) = message.to_parts();
        let packet = Packet { v: 1, suite: PROTOCOL.into(), olm: Base64::encode_string(&bytes), initial: if kind == 0 { live.initial.clone() } else { None } };
        if kind == 0 && packet.initial.is_none() { return Err(fail("Missing initial agreement")); }
        if kind != 0 { live.initial = None; }
        let encoded = serde_json::to_vec(&packet).map_err(|_| fail("Packet encoding failed"))?;
        serde_json::to_string(&serde_json::json!({"type":if kind==0 {3} else {2}, "bytes":Base64::encode_string(&encoded)})).map_err(|_| fail("Packet encoding failed"))
    }
    pub fn decrypt(&mut self, name: String, device: u32, kind: u32, ciphertext: &[u8]) -> Result<Vec<u8>> {
        if ciphertext.len() > 131072 || ![2,3].contains(&kind) { return Err(fail("Invalid packet type or size")); } let index = self.peer(&name, device)?;
        let packet: Packet = serde_json::from_slice(ciphertext).map_err(|_| fail("Invalid hybrid packet"))?;
        if packet.v != 1 || packet.suite != PROTOCOL || (kind == 3) != packet.initial.is_some() { return Err(fail("Wrong handshake protocol")); }
        if let Some(initial) = &packet.initial {
            let body = &initial.body; body.bundle.validate()?;
            if body.v != 1 || body.suite != PROTOCOL || body.from != name || body.to != self.name || body.from_identity != self.peers[index].identity || !(1..16380).contains(&body.from_registration)
                || body.bundle.identity_key != Base64::encode_string(&public(&self.account, &self.agreement)) || body.bundle.registration_id != self.registration { return Err(fail("Wrong handshake identity or address")); }
            if !verify_identity(&exact(&body.from_identity,64)?, &body.bytes()?, &exact(&initial.signature,64)?)? { return Err(fail("Handshake signature rejected")); }
            curve(&body.ephemeral)?; let ratchet = curve(&body.ratchet)?;
            self.agreement.diffie_hellman(&ratchet).ok_or_else(|| fail("Non-contributory initial ratchet"))?; exact(&body.kem_ciphertext,1088)?;
        }
        let message = OlmMessage::from_parts(if kind == 3 {0} else {1}, &binary(&packet.olm, 131072)?).map_err(|_| fail("Invalid ratchet message"))?;
        for position in 0..self.peers[index].sessions.len() {
            let backup = self.peers[index].sessions[position].session.pickle();
            match self.peers[index].sessions[position].session.decrypt(&message) {
                Ok(plaintext) => { let active = self.peers[index].sessions.remove(position); self.peers[index].sessions.insert(0,active); return Ok(plaintext); },
                Err(_) => self.peers[index].sessions[position].session = Session::from_pickle(backup),
            }
        }
        let initial = packet.initial.ok_or_else(|| fail("No matching ratchet session"))?; let body = &initial.body;
        let prekey_index = self.prekeys.iter().position(|key| key.id == body.bundle.pre_key_id).ok_or_else(|| fail("Initial prekey missing or already consumed"))?;
        let prekey = &self.prekeys[prekey_index]; if prekey.bundle != body.bundle { return Err(fail("Initial prekey does not match retained keys")); }
        let remote = public_parts(&exact(&body.from_identity,64)?)?.0; let ephemeral = curve(&body.ephemeral)?;
        let mut classical = Zeroizing::new(Vec::with_capacity(128)); dh(&prekey.signed,&remote,&mut classical)?; dh(&self.agreement,&ephemeral,&mut classical)?; dh(&prekey.signed,&ephemeral,&mut classical)?; dh(&prekey.one_time,&ephemeral,&mut classical)?;
        let seed = ml_kem::Seed::try_from(prekey.kem_seed.as_slice()).map_err(|_| fail("Invalid retained KEM seed"))?; let dk = ml_kem::DecapsulationKey::<MlKem768>::from_seed(seed);
        let ct_bytes = exact(&body.kem_ciphertext,1088)?; let ct = ml_kem::Ciphertext::<MlKem768>::try_from(ct_bytes.as_slice()).map_err(|_| fail("Invalid KEM ciphertext"))?;
        let mut shared = dk.decapsulate(&ct); let material = root_material(&classical,&shared,&body.bytes()?); shared.as_mut_slice().zeroize(); let material = material?;
        let mut session = Session::from_root_key_material_receiver(SessionConfig::version_1(),session_keys(body)?,material[..32].try_into().map_err(|_| fail("Root length"))?,material[32..].try_into().map_err(|_| fail("Chain length"))?,curve(&body.ratchet)?);
        let plaintext = session.decrypt(&message).map_err(|_| fail("Initial authentication rejected"))?;
        if self.consumed.len() >= 4096 { return Err(fail("Prekey acknowledgement queue full")); }
        self.prekeys.remove(prekey_index); self.consumed.push(body.bundle.pre_key_id);
        self.peers[index].sessions.insert(0,LiveSession {session,initial:None}); self.peers[index].sessions.truncate(40); Ok(plaintext)
    }
    pub fn snapshot(&self) -> Result<String> {
        let private = Zeroizing::new(serde_json::to_vec(&PrivateIdentity {v:1, account:self.account.pickle(),agreement:self.agreement.clone()}).map_err(|_| fail("Account snapshot failed"))?);
        let mut peers = Vec::new(); for peer in &self.peers {
            let sessions = peer.sessions.iter().map(|live| SavedSession {session:live.session.pickle(),initial:live.initial.clone()}).collect::<Vec<_>>();
            peers.push(SavedPeer {name:peer.name.clone(),device:peer.device,identity:peer.identity.clone(),session:if sessions.is_empty(){None}else{Some(serde_json::to_string(&sessions).map_err(|_| fail("Session snapshot failed"))?)}});
        }
        // Serialize the private tuples by reference; never copy them into a public bundle.
        let value = serde_json::json!({"v":2,"protocol":PROTOCOL,"name":self.name,"device":self.device,"registration":self.registration,"identity":Base64::encode_string(&private),"counter":self.counter,"peers":peers,"prekeys":self.prekeys,"consumed":self.consumed});
        let encoded = serde_json::to_string(&value).map_err(|_| fail("State snapshot failed"))?;
        if encoded.len()>32*1024*1024 {return Err(fail("State exceeds storage limit"));} Ok(encoded)
    }
    pub fn restore(name: String,device:u32,encoded:&str)->Result<Self>{
        if encoded.len()>32*1024*1024{return Err(fail("State exceeds storage limit"));}
        let state:State=serde_json::from_str(encoded).map_err(|_|fail("Invalid stored hybrid state"))?;
        if state.v!=2||state.protocol!=PROTOCOL||state.name!=name||state.device!=device||state.peers.len()>4096||state.prekeys.len()>2048||state.consumed.len()>4096{return Err(fail("Stored protocol, scope or limits mismatch"));}
        let private=Zeroizing::new(binary(&state.identity,256*1024)?);let mut result=Self::new(name,device,&private,state.registration)?;result.counter=state.counter;
        let mut seen=std::collections::BTreeSet::new();for peer in state.peers{
            if !seen.insert((peer.name.clone(),peer.device)){return Err(fail("Duplicate stored peer"));}
            result.pin(peer.name,peer.device,&exact(&peer.identity,64)?)?;
            if let Some(encoded)=peer.session{let saved:Vec<SavedSession>=serde_json::from_str(&encoded).map_err(|_|fail("Invalid saved session"))?;if saved.is_empty()||saved.len()>40{return Err(fail("Session storage limit"));}result.peers.last_mut().ok_or_else(||fail("Peer restore failed"))?.sessions=saved.into_iter().map(|saved|LiveSession{session:Session::from_pickle(saved.session),initial:saved.initial}).collect();}
        }
        let mut ids=std::collections::BTreeSet::new();for prekey in &state.prekeys{if prekey.id==0||prekey.id>state.counter||prekey.bundle.pre_key_id!=prekey.id||prekey.kem_seed.len()!=64||!ids.insert(prekey.id){return Err(fail("Invalid retained prekey"));}prekey.bundle.validate()?;}
        let mut consumed=std::collections::BTreeSet::new();for id in &state.consumed{if *id==0||*id>state.counter||ids.contains(id)||!consumed.insert(*id){return Err(fail("Invalid consumed prekey"));}}
        result.prekeys=state.prekeys;result.consumed=state.consumed;Ok(result)
    }
    pub fn consumed(&self)->Vec<u32>{self.consumed.clone()}
    pub fn acknowledge_consumed(&mut self,ids:&[u32]){self.consumed.retain(|id|!ids.contains(id));}
}
