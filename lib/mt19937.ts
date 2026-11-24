// Mersenne Twister MT19937, seeded exactly like CPython's random.Random(int).
//
// The ten-fold test must shuffle with the same permutation Python produces for
// random.Random(20261114), so the held-out numbers are reproducible across
// languages. CPython seeds MT19937 with init_by_array over the seed's 32-bit
// little-endian words, and shuffle() draws j = _randbelow(i + 1) for i from
// n-1 down to 1, where _randbelow(n) rejects getrandbits(n.bit_length())
// values >= n. getrandbits(k) for k <= 32 is genrand_int32() >> (32 - k).
// Verified against Python: shuffle of range(111) with seed 20261114 matches
// CPython element for element (111/111).

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class PythonRandom {
  private mt = new Uint32Array(N);
  private index = N + 1;

  constructor(seed: number) {
    // CPython: an int seed becomes its 32-bit little-endian words.
    const words: number[] = [];
    let v = Math.abs(Math.trunc(seed));
    if (v === 0) words.push(0);
    while (v > 0) {
      words.push(v >>> 0);
      v = Math.floor(v / 4294967296);
    }
    this.initByArray(words);
  }

  private initGenrand(s: number): void {
    this.mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = this.mt[i - 1]!;
      this.mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.index = N;
  }

  private initByArray(key: number[]): void {
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    const k = Math.max(N, key.length);
    for (let n = 0; n < k; n++) {
      const a = this.mt[i - 1]!;
      this.mt[i] = ((this.mt[i]! ^ Math.imul(a ^ (a >>> 30), 1664525)) + key[j]! + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1]!;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let n = 0; n < N - 1; n++) {
      const a = this.mt[i - 1]!;
      this.mt[i] = ((this.mt[i]! ^ Math.imul(a ^ (a >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        this.mt[0] = this.mt[N - 1]!;
        i = 1;
      }
    }
    this.mt[0] = 0x80000000;
    this.index = N;
  }

  private twist(): void {
    for (let i = 0; i < N; i++) {
      const x = (this.mt[i]! & UPPER_MASK) | (this.mt[(i + 1) % N]! & LOWER_MASK);
      let xA = x >>> 1;
      if (x & 1) xA ^= MATRIX_A;
      this.mt[i] = (this.mt[(i + M) % N]! ^ xA) >>> 0;
    }
    this.index = 0;
  }

  private int32(): number {
    if (this.index >= N) this.twist();
    let y = this.mt[this.index++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  private getrandbits(k: number): number {
    return this.int32() >>> (32 - k);
  }

  private randbelow(n: number): number {
    let bits = 0;
    let t = n;
    while (t > 0) {
      bits++;
      t >>>= 1;
    }
    let r = this.getrandbits(bits);
    while (r >= n) r = this.getrandbits(bits);
    return r;
  }

  /** Shuffle in place, exactly like CPython's random.shuffle. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.randbelow(i + 1);
      const tmp = arr[i]!;
      arr[i] = arr[j]!;
      arr[j] = tmp;
    }
    return arr;
  }
}
