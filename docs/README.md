# Docs

## Features

- [Build and publishing](publishing.md)
- [Event routing](event-routing.md) — registry, the listen cycle, which entry decodes a log, errors
- [Transport](transport.md) — `ethTransport`, why it never asks `eth_fillTransaction`
- [Tron](tron.md) — reading Tron over its `/jsonrpc`: configuration, writes, the local node, the test

## ADR

- [0001. The transport never asks eth_fillTransaction](adr/0001-transport-excludes-eth-fill-transaction.md) — for Cosmos EVM (`evmd`), on every chain
