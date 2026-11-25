// MT19937 (Mersenne Twister) compatible with CPython's random.Random.
// Replicates CPython's seeding (init_by_array over the seed's 32-bit words),
// genrand_uint32 output, getrandbits and _randbelow rejection sampling, and
// the Fisher-Yates shuffle order, so the TypeScript run reproduces the
// Python reference splits exactly. Node stdlib only.

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class MT19937 {
  private mt: Uint32Array = new Uint32Array(N);
  private mti: number = N + 1;

  constructor(seedInt: number) {
    // CPython seeds from an int by splitting it into 32-bit little-endian
    // words and calling init_by_array. Seed 20261114 fits in one word.
    const key: number[] = [];
    let s = seedInt >>> 0;
    if (s === 0) key.push(0);
    while (s > 0) {
      key.push(s >>> 0);
      s = Math.floor(s / 4294967296);
    }
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    this.mt[0] = s >>> 0;
    for (this.mti = 1; this.mti < N; this.mti++) {
      const prev = this.mt[this.mti - 1] >>> 0;
      const x = (prev ^ (prev >>> 30)) >>> 0;
      this.mt[this.mti] = (Math.imul(1812433253, x) + this.mti) >>> 0;
    }
  }

  private initByArray(initKey: number[]): void {
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    const keyLen = initKey.length;
    for (let k = Math.max(N, keyLen); k > 0; k--) {
      const a = this.mt[i - 1] >>> 0;
      const x = (a ^ (a >>> 30)) >>> 0;
      this.mt[i] =
        ((this.mt[i] ^ Math.imul(x, 1664525)) + initKey[j] + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1];
        i = 1;
      }
      if (j >= keyLen) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const a = this.mt[i - 1] >>> 0;
      const x = (a ^ (a >>> 30)) >>> 0;
      this.mt[i] = ((this.mt[i] ^ Math.imul(x, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1];
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
  }

  // One unsigned 32-bit output (CPython genrand_uint32).
  uint32(): number {
    if (this.mti >= N) this.twist();
    let y = this.mt[this.mti++] >>> 0;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  private twist(): void {
    const mag01 = [0, MATRIX_A];
    let kk = 0;
    for (; kk < N - M; kk++) {
      const y =
        ((this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK)) >>> 0;
      this.mt[kk] = (this.mt[kk + M] ^ (y >>> 1) ^ mag01[y & 1]) >>> 0;
    }
    for (; kk < N - 1; kk++) {
      const y =
        ((this.mt[kk] & UPPER_MASK) | (this.mt[kk + 1] & LOWER_MASK)) >>> 0;
      this.mt[kk] =
        (this.mt[kk + (M - N)] ^ (y >>> 1) ^ mag01[y & 1]) >>> 0;
    }
    const y =
      ((this.mt[N - 1] & UPPER_MASK) | (this.mt[0] & LOWER_MASK)) >>> 0;
    this.mt[N - 1] = (this.mt[M - 1] ^ (y >>> 1) ^ mag01[y & 1]) >>> 0;
    this.mti = 0;
  }

  // CPython getrandbits(k): k bits from the top of successive uint32 words.
  getrandbits(k: number): number {
    if (k <= 0) return 0;
    if (k <= 32) {
      return this.uint32() >>> (32 - k);
    }
    // k > 32: accumulate whole words, low word first (CPython order).
    let r = 0;
    let remaining = k;
    while (remaining > 0) {
      const take = Math.min(remaining, 32);
      const word = this.uint32() >>> (32 - take);
      r = r * 4294967296 + word;
      remaining -= take;
    }
    return r;
  }

  // CPython _randbelow(n): k = n.bit_length() (note: bit_length(n), NOT
  // bit_length(n-1) — they differ when n is a power of two, and the
  // rejection rate there shifts the stream).
  randbelow(n: number): number {
    if (n <= 0) throw new Error('_randbelow needs n > 0');
    const k = 32 - Math.clz32(n); // bit_length of n
    for (;;) {
      const r = this.getrandbits(k);
      if (r < n) return r;
    }
  }

  // CPython Random.randrange(n) for a plain range(n).
  randrange(n: number): number {
    return this.randbelow(n);
  }

  // CPython Random.shuffle: for i from len-1 down to 1, j = _randbelow(i+1).
  shuffle<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.randbelow(i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }
}
