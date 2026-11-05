import { PublicKeyDirectory } from '../models/nivra.models';
import { CheckedDeviceContinuity, ContinuityPeer, continuityCoordinates, continuityIdentity } from './device-continuity';
import { accountDeviceStatement, accountRootStatement, verifyAccountIdentity } from './account-identity';

/** Certificate validity is distinct from trust in its root. IdentityTrustService pins that root. */
export async function checkedAccountDevices(directory:PublicKeyDirectory,peers:Readonly<Record<string,ContinuityPeer>>,
  verify:(publicIdentity:string,message:Uint8Array,signature:string)=>Promise<boolean>):Promise<CheckedDeviceContinuity[]>{
  const root=directory.accountIdentity;
  if(!root||root.v!==1||!continuityCoordinates.test(root.rootKey)||!continuityCoordinates.test(root.sourceLegacy)||root.sourceHybrid?.length!==88||root.endorsement?.length!==88)return [];
  const signer=Object.prototype.hasOwnProperty.call(peers,root.sourceDeviceId)?peers[root.sourceDeviceId]:null;
  let rootEndorsed=false;
  try{rootEndorsed=!!signer&&signer.userId===directory.userId&&signer.legacy===root.sourceLegacy&&signer.identityKey===root.sourceHybrid&&await verify(root.sourceHybrid,accountRootStatement(directory.userId,root),root.endorsement);}catch{}
  const result:CheckedDeviceContinuity[]=[];
  for(const device of directory.devices.slice(0,128)){
    const certificate=device.accountCertificate;
    if(!certificate||certificate.v!==1||certificate.rootKey!==root.rootKey||certificate.deviceId!==device.deviceId||certificate.legacyKey!==continuityIdentity(device.keyBundle.identityKey)||certificate.hybridKey?.length!==88)continue;
    if(await verifyAccountIdentity(root.rootKey,accountDeviceStatement(directory.userId,certificate),certificate.signature))result.push({sourceDeviceId:root.sourceDeviceId,sourceIdentity:root.sourceLegacy,targetDeviceId:device.deviceId,targetIdentity:certificate.legacyKey,accountRoot:root.rootKey,rootEndorsed});
  }
  return result;
}
