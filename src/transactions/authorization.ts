import {
  AddressHashMode,
  AuthType,
  MultiSigHashMode,
  PubKeyEncoding,
  SingleSigHashMode,
} from './common/constants';

import { leftPadHex, txidFromData } from './common/utils';

import {
  addressFromPublicKeys,
  createEmptyAddress,
  createLPList,
  deserializeLPList,
  serializeLPList,
} from './types';

import {
  compressPublicKey,
  createStacksPublicKey,
  deserializePublicKey,
  getPublicKeyFromStacksPrivateKey,
  isCompressed,
  publicKeyFromSignature,
  serializePublicKey,
  signWithKey,
  StacksPrivateKey,
  StacksPublicKey,
} from './keys';

import {
  BufferArray,
  BufferReader,
  bytesToHex,
  cloneDeep,
  hexToBytes,
  IntegerType,
  writeUInt16BE,
  DeserializationError,
  SerializationError,
  SigningError,
  intToBigInt,
  intToBytes,
  concatByteArrays,
} from 'micro-stacks/common';
import { RECOVERABLE_ECDSA_SIG_LENGTH_BYTES, StacksMessageType } from 'micro-stacks/clarity';

export abstract class Deserializable {
  abstract serialize(): Uint8Array;

  abstract deserialize(bufferReader: BufferReader): void;

  static deserialize<T extends Deserializable>(this: new () => T, bufferReader: BufferReader): T {
    const message = new this();
    message.deserialize(bufferReader);
    return message;
  }
}

export interface MessageSignature {
  readonly type: StacksMessageType.MessageSignature;
  data: string;
}

export function createMessageSignature(signature: string): MessageSignature {
  const length = hexToBytes(signature).byteLength;
  if (length != RECOVERABLE_ECDSA_SIG_LENGTH_BYTES) {
    throw Error('Invalid signature');
  }

  return {
    type: StacksMessageType.MessageSignature,
    data: signature,
  };
}

export function emptyMessageSignature(): MessageSignature {
  return {
    type: StacksMessageType.MessageSignature,
    data: bytesToHex(new Uint8Array(RECOVERABLE_ECDSA_SIG_LENGTH_BYTES).fill(0x00)),
  };
}

export function serializeMessageSignature(messageSignature: MessageSignature): Uint8Array {
  const bufferArray: BufferArray = new BufferArray();
  bufferArray.appendHexString(messageSignature.data);
  return bufferArray.concatBuffer();
}

export function deserializeMessageSignature(bufferReader: BufferReader): MessageSignature {
  return createMessageSignature(
    bytesToHex(bufferReader.readBuffer(RECOVERABLE_ECDSA_SIG_LENGTH_BYTES))
  );
}

enum AuthFieldType {
  PublicKeyCompressed = 0x00,
  PublicKeyUncompressed = 0x01,
  SignatureCompressed = 0x02,
  SignatureUncompressed = 0x03,
}

export type TransactionAuthFieldContents = StacksPublicKey | MessageSignature;

export interface TransactionAuthField {
  type: StacksMessageType.TransactionAuthField;
  pubKeyEncoding: PubKeyEncoding;
  contents: TransactionAuthFieldContents;
}

export function createTransactionAuthField(
  pubKeyEncoding: PubKeyEncoding,
  contents: TransactionAuthFieldContents
): TransactionAuthField {
  return {
    pubKeyEncoding,
    type: StacksMessageType.TransactionAuthField,
    contents,
  };
}

export function serializeTransactionAuthField(field: TransactionAuthField): Uint8Array {
  const bufferArray: BufferArray = new BufferArray();

  switch (field.contents.type) {
    case StacksMessageType.PublicKey:
      if (field.pubKeyEncoding == PubKeyEncoding.Compressed) {
        bufferArray.appendByte(AuthFieldType.PublicKeyCompressed);
        bufferArray.push(serializePublicKey(field.contents));
      } else {
        bufferArray.appendByte(AuthFieldType.PublicKeyUncompressed);
        bufferArray.push(serializePublicKey(compressPublicKey(field.contents.data)));
      }
      break;
    case StacksMessageType.MessageSignature:
      if (field.pubKeyEncoding == PubKeyEncoding.Compressed) {
        bufferArray.appendByte(AuthFieldType.SignatureCompressed);
      } else {
        bufferArray.appendByte(AuthFieldType.SignatureUncompressed);
      }
      bufferArray.push(serializeMessageSignature(field.contents));
      break;
  }

  return bufferArray.concatBuffer();
}

export function deserializeTransactionAuthField(bufferReader: BufferReader): TransactionAuthField {
  const authFieldType = bufferReader.readUInt8Enum(AuthFieldType, n => {
    throw new DeserializationError(`Could not read ${n} as AuthFieldType`);
  });

  switch (authFieldType) {
    case AuthFieldType.PublicKeyCompressed:
      return createTransactionAuthField(
        PubKeyEncoding.Compressed,
        deserializePublicKey(bufferReader)
      );
    case AuthFieldType.PublicKeyUncompressed:
      return createTransactionAuthField(
        PubKeyEncoding.Uncompressed,
        deserializePublicKey(bufferReader)
      );
    case AuthFieldType.SignatureCompressed:
      return createTransactionAuthField(
        PubKeyEncoding.Compressed,
        deserializeMessageSignature(bufferReader)
      );
    case AuthFieldType.SignatureUncompressed:
      return createTransactionAuthField(
        PubKeyEncoding.Uncompressed,
        deserializeMessageSignature(bufferReader)
      );
    default:
      throw new Error(`Unknown auth field type: ${JSON.stringify(authFieldType)}`);
  }
}

export interface SingleSigSpendingCondition {
  hashMode: SingleSigHashMode;
  signer: string;
  nonce: bigint;
  fee: bigint;
  keyEncoding: PubKeyEncoding;
  signature: MessageSignature;
}

export interface SingleSigSpendingConditionOpts
  extends Omit<SingleSigSpendingCondition, 'nonce' | 'fee'> {
  nonce: IntegerType;
  fee: IntegerType;
}

export interface MultiSigSpendingCondition {
  hashMode: MultiSigHashMode;
  signer: string;
  nonce: bigint;
  fee: bigint;
  fields: TransactionAuthField[];
  signaturesRequired: number;
}

export interface MultiSigSpendingConditionOpts
  extends Omit<MultiSigSpendingCondition, 'nonce' | 'fee'> {
  nonce: IntegerType;
  fee: IntegerType;
}

export type SpendingCondition = SingleSigSpendingCondition | MultiSigSpendingCondition;

export type SpendingConditionOpts = SingleSigSpendingConditionOpts | MultiSigSpendingConditionOpts;

export function createSingleSigSpendingCondition(
  hashMode: SingleSigHashMode,
  pubKey: string,
  nonce: IntegerType,
  fee: IntegerType
): SingleSigSpendingCondition {
  // address version arg doesn't matter for signer hash generation
  const signer = addressFromPublicKeys(0, hashMode, 1, [createStacksPublicKey(pubKey)]).hash160;
  const keyEncoding = isCompressed(createStacksPublicKey(pubKey))
    ? PubKeyEncoding.Compressed
    : PubKeyEncoding.Uncompressed;

  return {
    hashMode,
    signer,
    nonce: intToBigInt(nonce, false),
    fee: intToBigInt(fee, false),
    keyEncoding,
    signature: emptyMessageSignature(),
  };
}

export function createMultiSigSpendingCondition(
  hashMode: MultiSigHashMode,
  numSigs: number,
  pubKeys: string[],
  nonce: IntegerType,
  fee: IntegerType
): MultiSigSpendingCondition {
  const stacksPublicKeys = pubKeys.map(createStacksPublicKey);

  // address version arg doesn't matter for signer hash generation
  const signer = addressFromPublicKeys(0, hashMode, numSigs, stacksPublicKeys).hash160;

  return {
    hashMode,
    signer,
    nonce: intToBigInt(nonce, false),
    fee: intToBigInt(fee, false),
    fields: [],
    signaturesRequired: numSigs,
  };
}

export function isSingleSig(
  condition: SpendingConditionOpts
): condition is SingleSigSpendingConditionOpts {
  return 'signature' in condition;
}

function clearCondition(condition: SpendingConditionOpts): SpendingCondition {
  const cloned = cloneDeep(condition);
  cloned.nonce = 0;
  cloned.fee = 0;

  if (isSingleSig(cloned)) {
    cloned.signature = emptyMessageSignature();
  } else {
    cloned.fields = [];
  }

  return {
    ...cloned,
    nonce: BigInt(0),
    fee: BigInt(0),
  };
}

export function serializeSingleSigSpendingCondition(
  condition: SingleSigSpendingConditionOpts
): Uint8Array {
  const bufferArray: BufferArray = new BufferArray();
  bufferArray.appendByte(condition.hashMode);
  bufferArray.appendHexString(condition.signer);
  bufferArray.push(intToBytes(condition.nonce, false, 8));
  bufferArray.push(intToBytes(condition.fee, false, 8));
  bufferArray.appendByte(condition.keyEncoding);
  bufferArray.push(serializeMessageSignature(condition.signature));
  return bufferArray.concatBuffer();
}

export function serializeMultiSigSpendingCondition(
  condition: MultiSigSpendingConditionOpts
): Uint8Array {
  const bufferArray: BufferArray = new BufferArray();
  bufferArray.appendByte(condition.hashMode);
  bufferArray.appendHexString(condition.signer);
  bufferArray.push(intToBytes(condition.nonce, false, 8));
  bufferArray.push(intToBytes(condition.fee, false, 8));

  const fields = createLPList(condition.fields);
  bufferArray.push(serializeLPList(fields));

  const numSigs = new Uint8Array(2);
  writeUInt16BE(numSigs, condition.signaturesRequired, 0);
  bufferArray.push(numSigs);
  return bufferArray.concatBuffer();
}

export function deserializeSingleSigSpendingCondition(
  hashMode: SingleSigHashMode,
  bufferReader: BufferReader
): SingleSigSpendingCondition {
  const signer = bytesToHex(bufferReader.readBuffer(20));
  const nonce = BigInt('0x' + bytesToHex(bufferReader.readBuffer(8)));
  const fee = BigInt('0x' + bytesToHex(bufferReader.readBuffer(8)));

  const keyEncoding = bufferReader.readUInt8Enum(PubKeyEncoding, n => {
    throw new DeserializationError(`Could not parse ${n} as PubKeyEncoding`);
  });

  if (hashMode === AddressHashMode.SerializeP2WPKH && keyEncoding != PubKeyEncoding.Compressed) {
    throw new DeserializationError(
      'Failed to parse singlesig spending condition: incomaptible hash mode and key encoding'
    );
  }

  const signature = deserializeMessageSignature(bufferReader);
  return {
    hashMode,
    signer,
    nonce,
    fee,
    keyEncoding,
    signature,
  };
}

export function deserializeMultiSigSpendingCondition(
  hashMode: MultiSigHashMode,
  bufferReader: BufferReader
): MultiSigSpendingCondition {
  const signer = bytesToHex(bufferReader.readBuffer(20));
  const nonce = BigInt('0x' + bytesToHex(bufferReader.readBuffer(8)));
  const fee = BigInt('0x' + bytesToHex(bufferReader.readBuffer(8)));

  const fields = deserializeLPList(bufferReader, StacksMessageType.TransactionAuthField)
    .values as TransactionAuthField[];

  let haveUncompressed = false;
  let numSigs = 0;

  for (const field of fields) {
    switch (field.contents.type) {
      case StacksMessageType.PublicKey:
        if (!isCompressed(field.contents)) haveUncompressed = true;
        break;
      case StacksMessageType.MessageSignature:
        if (field.pubKeyEncoding === PubKeyEncoding.Uncompressed) haveUncompressed = true;
        numSigs += 1;
        if (numSigs === 65536)
          throw new TypeError('Failed to parse multisig spending condition: too many signatures');
        break;
    }
  }

  const signaturesRequired = bufferReader.readUInt16BE();

  if (numSigs !== signaturesRequired) throw new TypeError(`Incorrect number of signatures`);

  if (haveUncompressed && hashMode === AddressHashMode.SerializeP2SH)
    throw new TypeError('Uncompressed keys are not allowed in this hash mode');

  return {
    hashMode,
    signer,
    nonce,
    fee,
    fields,
    signaturesRequired,
  };
}

export function serializeSpendingCondition(condition: SpendingConditionOpts): Uint8Array {
  if (isSingleSig(condition)) {
    return serializeSingleSigSpendingCondition(condition);
  } else {
    return serializeMultiSigSpendingCondition(condition);
  }
}

export function deserializeSpendingCondition(bufferReader: BufferReader): SpendingCondition {
  const hashMode = bufferReader.readUInt8Enum(AddressHashMode, n => {
    throw new DeserializationError(`Could not parse ${n} as AddressHashMode`);
  });

  if (hashMode === AddressHashMode.SerializeP2PKH || hashMode === AddressHashMode.SerializeP2WPKH) {
    return deserializeSingleSigSpendingCondition(hashMode, bufferReader);
  } else {
    return deserializeMultiSigSpendingCondition(hashMode, bufferReader);
  }
}

export function makeSigHashPreSign(
  curSigHash: string,
  authType: AuthType,
  fee: IntegerType,
  nonce: IntegerType
): string {
  // new hash combines the previous hash and all the new data this signature will add. This
  // includes:
  // * the previous hash
  // * the auth flag
  // * the tx fee (big-endian 8-byte number)
  // * nonce (big-endian 8-byte number)
  const hashLength = 32 + 1 + 8 + 8;

  const sigHash = [
    hexToBytes(curSigHash),
    Uint8Array.from([authType]),
    intToBytes(fee, false, 8),
    intToBytes(nonce, false, 8),
  ];

  const buff = concatByteArrays(sigHash);

  if (buff.byteLength !== hashLength) {
    throw Error('Invalid signature hash length');
  }

  return txidFromData(buff);
}

function makeSigHashPostSign(
  curSigHash: string,
  pubKey: StacksPublicKey,
  signature: MessageSignature
): string {
  // new hash combines the previous hash and all the new data this signature will add.  This
  // includes:
  // * the public key compression flag
  // * the signature
  const hashLength = 32 + 1 + RECOVERABLE_ECDSA_SIG_LENGTH_BYTES;

  const pubKeyEncoding = isCompressed(pubKey)
    ? PubKeyEncoding.Compressed
    : PubKeyEncoding.Uncompressed;

  const sigHash = curSigHash + leftPadHex(pubKeyEncoding.toString(16)) + signature.data;

  const sigHashBuffer = hexToBytes(sigHash);
  if (sigHashBuffer.byteLength > hashLength) {
    throw Error('Invalid signature hash length');
  }

  return txidFromData(sigHashBuffer);
}

export async function nextSignature(
  curSigHash: string,
  authType: AuthType,
  fee: IntegerType,
  nonce: IntegerType,
  privateKey: StacksPrivateKey
): Promise<{
  nextSig: MessageSignature;
  nextSigHash: string;
}> {
  const sigHashPreSign = makeSigHashPreSign(curSigHash, authType, fee, nonce);

  const signature = await signWithKey(privateKey, sigHashPreSign);
  const publicKey = getPublicKeyFromStacksPrivateKey(privateKey);
  const nextSigHash = makeSigHashPostSign(sigHashPreSign, publicKey, signature);

  return {
    nextSig: signature,
    nextSigHash,
  };
}

export function nextVerification(
  initialSigHash: string,
  authType: AuthType,
  fee: IntegerType,
  nonce: IntegerType,
  pubKeyEncoding: PubKeyEncoding,
  signature: MessageSignature
) {
  const sigHashPreSign = makeSigHashPreSign(initialSigHash, authType, fee, nonce);

  const publicKey = createStacksPublicKey(
    publicKeyFromSignature(sigHashPreSign, signature, pubKeyEncoding)
  );

  const nextSigHash = makeSigHashPostSign(sigHashPreSign, publicKey, signature);

  return {
    pubKey: publicKey,
    nextSigHash,
  };
}

function newInitialSigHash(): SpendingCondition {
  const spendingCondition = createSingleSigSpendingCondition(
    AddressHashMode.SerializeP2PKH,
    '',
    0,
    0
  );
  spendingCondition.signer = createEmptyAddress().hash160;
  spendingCondition.keyEncoding = PubKeyEncoding.Compressed;
  spendingCondition.signature = emptyMessageSignature();
  return spendingCondition;
}

function verify(
  condition: SpendingConditionOpts,
  initialSigHash: string,
  authType: AuthType
): string {
  if (isSingleSig(condition)) {
    return verifySingleSig(condition, initialSigHash, authType);
  } else {
    return verifyMultiSig(condition, initialSigHash, authType);
  }
}

function verifySingleSig(
  condition: SingleSigSpendingConditionOpts,
  initialSigHash: string,
  authType: AuthType
): string {
  const { nextSigHash, pubKey } = nextVerification(
    initialSigHash,
    authType,
    condition.fee,
    condition.nonce,
    condition.keyEncoding,
    condition.signature
  );

  const addrBytes = addressFromPublicKeys(0, condition.hashMode, 1, [pubKey]).hash160;

  if (addrBytes !== condition.signer)
    throw new TypeError(
      `Signer hash does not equal hash of public key(s): ${addrBytes} != ${condition.signer}`
    );

  return nextSigHash;
}

function verifyMultiSig(
  condition: MultiSigSpendingConditionOpts,
  initialSigHash: string,
  authType: AuthType
): string {
  const publicKeys: StacksPublicKey[] = [];
  let curSigHash = initialSigHash;
  let haveUncompressed = false;
  let numSigs = 0;

  for (const field of condition.fields) {
    let foundPubKey: StacksPublicKey;

    switch (field.contents.type) {
      case StacksMessageType.PublicKey:
        if (!isCompressed(field.contents)) haveUncompressed = true;
        foundPubKey = field.contents;
        break;
      case StacksMessageType.MessageSignature:
        if (field.pubKeyEncoding === PubKeyEncoding.Uncompressed) haveUncompressed = true;
        const { pubKey, nextSigHash } = nextVerification(
          curSigHash,
          authType,
          condition.fee,
          condition.nonce,
          field.pubKeyEncoding,
          field.contents
        );
        curSigHash = nextSigHash;
        foundPubKey = pubKey;

        numSigs += 1;
        if (numSigs === 65536) throw new TypeError('Too many signatures');

        break;
    }
    publicKeys.push(foundPubKey);
  }

  if (numSigs !== condition.signaturesRequired)
    throw new TypeError('Incorrect number of signatures');

  if (haveUncompressed && condition.hashMode === AddressHashMode.SerializeP2SH)
    throw new TypeError('Uncompressed keys are not allowed in this hash mode');

  const addrBytes = addressFromPublicKeys(
    0,
    condition.hashMode,
    condition.signaturesRequired,
    publicKeys
  ).hash160;
  if (addrBytes !== condition.signer)
    throw new TypeError(
      `Signer hash does not equal hash of public key(s): ${addrBytes} != ${condition.signer}`
    );

  return curSigHash;
}

export class Authorization extends Deserializable {
  authType?: AuthType;
  spendingCondition?: SpendingCondition;
  sponsorSpendingCondition?: SpendingCondition;

  constructor(
    authType?: AuthType,
    spendingConditions?: SpendingConditionOpts,
    sponsorSpendingCondition?: SpendingConditionOpts
  ) {
    super();
    this.authType = authType;
    if (spendingConditions) {
      this.spendingCondition = {
        ...spendingConditions,
        nonce: intToBigInt(spendingConditions.nonce, false),
        fee: intToBigInt(spendingConditions.fee, false),
      };
    }
    if (sponsorSpendingCondition) {
      this.sponsorSpendingCondition = {
        ...sponsorSpendingCondition,
        nonce: intToBigInt(sponsorSpendingCondition.nonce, false),
        fee: intToBigInt(sponsorSpendingCondition.fee, false),
      };
    }
  }

  intoInitialSighashAuth(): StandardAuthorization | SponsoredAuthorization {
    if (this.spendingCondition) {
      switch (this.authType) {
        case AuthType.Standard:
          return new StandardAuthorization(clearCondition(this.spendingCondition));
        case AuthType.Sponsored:
          return new SponsoredAuthorization(
            clearCondition(this.spendingCondition),
            newInitialSigHash()
          );
        default:
          throw new SigningError('Unexpected authorization type for signing');
      }
    }

    throw new Error('Authorization missing SpendingCondition');
  }

  setFee(amount: IntegerType) {
    switch (this.authType) {
      case AuthType.Standard:
        this.spendingCondition!.fee = intToBigInt(amount, false);
        break;
      case AuthType.Sponsored:
        this.sponsorSpendingCondition!.fee = intToBigInt(amount, false);
        break;
    }
  }

  getFee(): bigint {
    switch (this.authType) {
      case AuthType.Standard:
        return this.spendingCondition!.fee;
      case AuthType.Sponsored:
        return this.sponsorSpendingCondition!.fee;
      default:
        return BigInt(0);
    }
  }

  setNonce(nonce: IntegerType) {
    this.spendingCondition!.nonce = intToBigInt(nonce, false);
  }

  setSponsorNonce(nonce: IntegerType) {
    this.sponsorSpendingCondition!.nonce = intToBigInt(nonce, false);
  }

  setSponsor(sponsorSpendingCondition: SpendingConditionOpts) {
    this.sponsorSpendingCondition = {
      ...sponsorSpendingCondition,
      nonce: intToBigInt(sponsorSpendingCondition.nonce, false),
      fee: intToBigInt(sponsorSpendingCondition.fee, false),
    };
  }

  verifyOrigin(initialSigHash: string): string {
    switch (this.authType) {
      case AuthType.Standard:
        return verify(this.spendingCondition!, initialSigHash, AuthType.Standard);
      case AuthType.Sponsored:
        return verify(this.spendingCondition!, initialSigHash, AuthType.Standard);
      default:
        throw new SigningError('Invalid origin auth type');
    }
  }

  serialize(): Uint8Array {
    const bufferArray: BufferArray = new BufferArray();
    if (this.authType === undefined) {
      throw new SerializationError('"authType" is undefined');
    }
    bufferArray.appendByte(this.authType);

    switch (this.authType) {
      case AuthType.Standard:
        if (this.spendingCondition === undefined) {
          throw new SerializationError('"spendingCondition" is undefined');
        }
        bufferArray.push(serializeSpendingCondition(this.spendingCondition));
        break;
      case AuthType.Sponsored:
        if (this.spendingCondition === undefined) {
          throw new SerializationError('"spendingCondition" is undefined');
        }
        if (this.sponsorSpendingCondition === undefined) {
          throw new SerializationError('"spendingCondition" is undefined');
        }
        bufferArray.push(serializeSpendingCondition(this.spendingCondition));
        bufferArray.push(serializeSpendingCondition(this.sponsorSpendingCondition));
        break;
      default:
        throw new SerializationError(
          `Unexpected transaction AuthType while serializing: ${JSON.stringify(this.authType)}`
        );
    }

    return bufferArray.concatBuffer();
  }

  deserialize(bufferReader: BufferReader) {
    this.authType = bufferReader.readUInt8Enum(AuthType, n => {
      throw new DeserializationError(`Could not parse ${n} as AuthType`);
    });

    switch (this.authType) {
      case AuthType.Standard:
        this.spendingCondition = deserializeSpendingCondition(bufferReader);
        break;
      case AuthType.Sponsored:
        this.spendingCondition = deserializeSpendingCondition(bufferReader);
        this.sponsorSpendingCondition = deserializeSpendingCondition(bufferReader);
        break;
      // throw new DeserializationError('Not yet implemented: deserializing sponsored transactions');
      default:
        throw new DeserializationError(
          `Unexpected transaction AuthType while deserializing: ${JSON.stringify(this.authType)}`
        );
    }
  }
}

export class StandardAuthorization extends Authorization {
  constructor(spendingCondition: SpendingConditionOpts) {
    super(AuthType.Standard, spendingCondition);
  }
}

const DEFAULT_SPONSOR_SPENDING_CONDITION: SpendingConditionOpts = {
  hashMode: 0,
  signer: '29cfc6376255a78451eeb4b129ed8eacffa2feef',
  nonce: 0n,
  fee: 0n,
  keyEncoding: 0,
  signature: {
    type: 9,
    data: '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  },
};

export class SponsoredAuthorization extends Authorization {
  constructor(
    originSpendingCondition: SpendingConditionOpts,
    sponsorSpendingCondition?: SpendingConditionOpts
  ) {
    let sponsorSC = sponsorSpendingCondition;
    if (!sponsorSC) sponsorSC = DEFAULT_SPONSOR_SPENDING_CONDITION;
    super(AuthType.Sponsored, originSpendingCondition, sponsorSC);
  }
}
