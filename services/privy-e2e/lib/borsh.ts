// Copied from services/common/src/borsh.ts (not imported -- this
// folder stays self-contained per the task's scope rule). Minimal
// borsh encoder for exactly the submit_outcome signature buffer shape.
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
