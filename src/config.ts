import 'dotenv/config';

export const config = {
  litellmApiKey: process.env.LITELLM_API_KEY ?? '',
  litellmModel: process.env.LITELLM_MODEL ?? 'nova-lite',
  litellmBaseUrl: process.env.LITELLM_BASE_URL ?? '',
  githubToken: process.env.GITHUB_TOKEN ?? '',
  neatlogsApiKey: process.env.NEATLOGS_API_KEY ?? '',
  neatlogsEndpoint: 'https://ingest.neatlogs.com',
} as const;

export function assertLitellmReady(): void {
  if (!config.litellmApiKey) throw new Error('LITELLM_API_KEY is missing (see .env.example).');
  if (!config.litellmBaseUrl) {
    throw new Error(
      'LITELLM_BASE_URL is missing. Read it in a browser at neatlogs.com/hackathon/models (PLAN.md open item) and set it in .env.',
    );
  }
}
