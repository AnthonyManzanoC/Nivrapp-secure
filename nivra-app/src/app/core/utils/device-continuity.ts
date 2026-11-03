import type { PublicKeyDirectory } from '../models/nivra.models';

export interface DeviceContinuityProof { sourceDeviceId: string; signature: string; }
export interface CheckedDeviceContinuity { sourceDeviceId: string; sourceIdentity: string; targetDeviceId: string; targetIdentity: string; }
export interface ContinuityPeer { userId: string; identityKey: string; legacy: string; }
export const continuityCoordinates = /^[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}$/;
const idPattern=/^[A-Za-z0-9_-]{1,128}$/;

export function continuityIdentity(value: string | JsonWebKey | null | undefined): string {
  try {
    const key=typeof value==='string'?JSON.parse(value) as JsonWebKey:value;
    if(!key||key.kty!=='EC'||key.crv!=='P-256'||Object.prototype.hasOwnProperty.call(key,'d'))return '';
    const coordinates=`${key.x}:${key.y}`;
    return continuityCoordinates.test(coordinates)?coordinates:'';
  }catch{return '';}
}

export function continuityStatement(userId:string,sourceDeviceId:string,targetIdentity:string):Uint8Array<ArrayBuffer> {
  if(!idPattern.test(userId)||!idPattern.test(sourceDeviceId)||!continuityCoordinates.test(targetIdentity))throw Error('La autorización del equipo no es válida.');
  // QR sign-in receives its server device ID after approval. Bind the exact
  // public key generated on the target; ratchet binding proves its possession.
  return new TextEncoder().encode(JSON.stringify(['nivra-device-continuity-v1',userId,sourceDeviceId,targetIdentity]));
}

/** The signer must already be authenticated by this device's hybrid ratchet. */
export async function checkedDeviceContinuities(directory:PublicKeyDirectory,peers:Readonly<Record<string,ContinuityPeer>>,
  verify:(publicIdentity:string,message:Uint8Array,signature:string)=>Promise<boolean>):Promise<CheckedDeviceContinuity[]> {
  const devices=new Map(directory.devices.map(device=>[device.deviceId,device]));
  const checked:CheckedDeviceContinuity[]=[];
  for(const target of directory.devices.slice(0,128)){
    const proof=target.continuity;
    if(!proof||!idPattern.test(proof.sourceDeviceId)||proof.sourceDeviceId===target.deviceId||typeof proof.signature!=='string'||proof.signature.length!==88)continue;
    if(!Object.prototype.hasOwnProperty.call(peers,proof.sourceDeviceId))continue;
    const signer=peers[proof.sourceDeviceId],source=devices.get(proof.sourceDeviceId);
    const sourceIdentity=continuityIdentity(source?.keyBundle.identityKey),targetIdentity=continuityIdentity(target.keyBundle.identityKey);
    if(signer.userId!==directory.userId||!sourceIdentity||signer.legacy!==sourceIdentity||!targetIdentity)continue;
    try{
      if(await verify(signer.identityKey,continuityStatement(directory.userId,proof.sourceDeviceId,targetIdentity),proof.signature))
        checked.push({sourceDeviceId:proof.sourceDeviceId,sourceIdentity,targetDeviceId:target.deviceId,targetIdentity});
    }catch{/* An invalid or unsupported proof never establishes trust. */}
  }
  return checked;
}
