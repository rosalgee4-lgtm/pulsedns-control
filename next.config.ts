import type { NextConfig } from 'next';

const configuredBasePath = process.env.PULSEDNS_BASE_PATH?.trim() ?? '';
const basePath = /^\/[a-f0-9]{32}$/.test(configuredBasePath) ? configuredBasePath : '';

const nextConfig: NextConfig = { basePath };

export default nextConfig;
