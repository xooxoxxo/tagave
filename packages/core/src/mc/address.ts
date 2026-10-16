/**
 * The resolved-address half of the Music Connections SSRF rules (blocked,
 * loopback, private, public), from the music-connections package (address.ts
 * there). remote.ts resolves each name and checks every answer with them.
 */
export { addressAllowed, bareHost, classifyAddress, isLiteralLoopback, v6Groups, type AddressClass } from 'music-connections';
