/**
 * Simulates Node 18, where WebCrypto is not a global (#28).
 *
 * `globalThis.crypto` only arrived in Node 19. `age-encryption` reaches
 * `@noble/*`, which reads `crypto.getRandomValues`, so on Node 18 every
 * encrypt and every keygen failed while decryption passed — an asymmetry no
 * amount of local testing on a modern Node would have surfaced.
 *
 * Removing the global here makes that condition reproducible on any Node
 * version, so `npm run test:no-webcrypto` catches the regression instead of
 * only the Node 18 leg of the CI matrix noticing several pushes later.
 */

delete (globalThis as { crypto?: unknown }).crypto;
