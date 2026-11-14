// Minimal borsh encoder for exactly the two primitive kinds the escrow
// contract serializes when building the `submit_outcome` signature buffer
// (see contracts/escrow/src/lib.rs `submit_outcome`): String (u32 LE length
// prefix + utf8 bytes) and u64 (8 bytes LE). Not a general borsh lib —
// scoped deliberately to avoid drifting from the one buffer shape that
// matters.
export class BorshWriter {
  private chunks: Buffer[] = [];

  string(s: string): this {
    const bytes = Buffer.from(s, "utf8");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length, 0);
    this.chunks.push(len, bytes);
    return this;
  }

  u32(n: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    this.chunks.push(b);
    return this;
  }

  u64(n: number | bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n), 0);
    this.chunks.push(b);
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
