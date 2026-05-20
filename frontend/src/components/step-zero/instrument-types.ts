// Backend response shapes for /api/step-zero/instrument/*.
// Kept in sync with backend/routes/step-zero/instrument-templates.js by
// convention (no shared schema; if the backend changes, update here).

export type Language = 'java' | 'python' | 'dotnet' | 'node';
export type EndpointMode = 'compose' | 'standalone' | 'host';

export type ManualSnippet = {
  install: string;
  init: string;
  spanExample: string;
  docsUrl: string;
};

export type SnippetResponse = {
  compose: string;
  shell: string;
  prereqs: string;
  agentDownload: string | null;
  manual: ManualSnippet;
  zeroCodeDocsUrl: string;
};
