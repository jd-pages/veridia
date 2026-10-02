import type http from 'node:http';
export function installApiConnectionClose(port: number, transport?: typeof http): () => void;
