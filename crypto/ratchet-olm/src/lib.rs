//! WebAssembly boundary for Nivra hybrid Double Ratchet sessions.
use wasm_bindgen::prelude::*;
use zeroize::Zeroizing;
mod hybrid;
fn js<T>(result: hybrid::Result<T>) -> Result<T, JsValue> { result.map_err(|error| JsValue::from_str(&error)) }
#[wasm_bindgen(js_name = protocolSuite)]
pub fn protocol_suite() -> String { hybrid::PROTOCOL.into() }
#[wasm_bindgen(js_name = bridgeVersion)]
pub fn bridge_version() -> String { "NIVRA-HYBRID-WASM-1".into() }
#[wasm_bindgen(js_name = createIdentity)]
pub fn create_identity() -> Result<Vec<u8>, JsValue> { js(hybrid::create_identity()) }
#[wasm_bindgen(js_name = identityPublic)]
pub fn identity_public(private: &[u8]) -> Result<Vec<u8>, JsValue> { js(hybrid::identity_public(private)) }
#[wasm_bindgen(js_name = signIdentity)]
pub fn sign_identity(private: &[u8], message: &[u8]) -> Result<Vec<u8>, JsValue> { js(hybrid::sign_identity(private,message)) }
#[wasm_bindgen(js_name = verifyIdentity)]
pub fn verify_identity(public: &[u8], message: &[u8], signature: &[u8]) -> Result<bool, JsValue> { js(hybrid::verify_identity(public,message,signature)) }
#[wasm_bindgen(js_name=mlKemVector)]
pub fn ml_kem_vector(seed:&[u8],entropy:&[u8])->Result<String,JsValue>{js(hybrid::ml_kem_vector(seed,entropy))}
#[wasm_bindgen]
pub struct RatchetDevice { engine: hybrid::Engine, name: String, device: u32, transaction: u32, checkpoint: Option<(u32,Zeroizing<String>)> }
#[wasm_bindgen]
impl RatchetDevice {
    #[wasm_bindgen(constructor)]
    pub fn new(name:String,device:u32,private:&[u8],registration:u32)->Result<Self,JsValue>{
        Ok(Self{engine:js(hybrid::Engine::new(name.clone(),device,private,registration))?,name,device,transaction:0,checkpoint:None})
    }
    #[wasm_bindgen(js_name=pinIdentity)]
    pub fn pin_identity(&mut self,name:String,device:u32,public:&[u8])->Result<(),JsValue>{js(self.engine.pin(name,device,public))}
    #[wasm_bindgen(js_name=preKeyBundle)]
    pub fn pre_key_bundle(&mut self,_now:f64)->Result<String,JsValue>{js(self.engine.bundle())}
    pub fn establish(&mut self,name:String,device:u32,bundle:String,_now:f64)->Result<(),JsValue>{js(self.engine.establish(name,device,&bundle))}
    pub fn encrypt(&mut self,name:String,device:u32,plaintext:&[u8],_now:f64)->Result<String,JsValue>{js(self.engine.encrypt(name,device,plaintext))}
    pub fn decrypt(&mut self,name:String,device:u32,kind:u32,ciphertext:&[u8])->Result<Vec<u8>,JsValue>{js(self.engine.decrypt(name,device,kind,ciphertext))}
    #[wasm_bindgen(js_name=exportPrivateStateForEncryption)]
    pub fn export_private_state(&self)->Result<String,JsValue>{js(self.engine.snapshot())}
    #[wasm_bindgen(js_name=restorePrivateState)]
    pub fn restore_private_state(name:String,device:u32,encoded:String)->Result<Self,JsValue>{
        Ok(Self{engine:js(hybrid::Engine::restore(name.clone(),device,&encoded))?,name,device,transaction:0,checkpoint:None})
    }
    #[wasm_bindgen(js_name=consumedPreKeys)]
    pub fn consumed_prekeys(&self)->Vec<u32>{self.engine.consumed()}
    #[wasm_bindgen(js_name=acknowledgeConsumedPreKeys)]
    pub fn acknowledge_consumed_prekeys(&mut self,ids:&[u32]){self.engine.acknowledge_consumed(ids)}
    pub fn checkpoint(&mut self)->Result<u32,JsValue>{
        if self.checkpoint.is_some(){return Err(JsValue::from_str("Transaction already open"));}
        let next=self.transaction.checked_add(1).ok_or_else(||JsValue::from_str("Transaction counter exhausted"))?;
        self.checkpoint=Some((next,Zeroizing::new(js(self.engine.snapshot())?)));self.transaction=next;Ok(next)
    }
    pub fn commit(&mut self,token:u32)->Result<(),JsValue>{
        if self.checkpoint.as_ref().map(|value|value.0)!=Some(token){return Err(JsValue::from_str("Invalid transaction token"));}
        self.checkpoint=None;Ok(())
    }
    pub fn rollback(&mut self,token:u32)->Result<(),JsValue>{
        if self.checkpoint.as_ref().map(|value|value.0)!=Some(token){return Err(JsValue::from_str("Invalid transaction token"));}
        let (_,encoded)=self.checkpoint.take().ok_or_else(||JsValue::from_str("Missing transaction"))?;
        self.engine=js(hybrid::Engine::restore(self.name.clone(),self.device,&encoded))?;Ok(())
    }
}
