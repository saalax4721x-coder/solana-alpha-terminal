# Solana Alpha Terminal

Real-time Solana intelligence terminal for whale activity, smart wallets, token discovery, developer reputation, KOL activity, Twitter signals, and narrative analysis.

## Architecture

- `apps/web` — premium dashboard UI
- `apps/api` — real-time API and blockchain ingestion
- `packages/shared` — shared types and utilities
- `database` — PostgreSQL schema and migrations

## Core data sources

- Helius for Solana RPC and real-time blockchain data
- Additional market/token data providers as configured
- PostgreSQL for persistent historical data

## Security

Never commit API keys, RPC URLs containing secrets, wallet private keys, or other credentials. Use environment variables and local `.env` files that are ignored by Git.

## Status

Foundation initialized. Next: establish the monorepo structure, environment configuration, database schema, and real-time ingestion pipeline.
