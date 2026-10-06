import { AgentAuthorize } from '@/components/AgentAuthorize';

type Param = string | string[] | undefined;

function one(value: Param): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Where the staff AI assistant sends a signed-in staff member to sign in with NOLON (OAuth-style
 * query names). The API checks everything; this page only passes the values on.
 */
export default async function AgentAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, Param>>;
}) {
  const q = await searchParams;
  return (
    <AgentAuthorize
      clientId={one(q.client_id)}
      redirectUri={one(q.redirect_uri)}
      state={one(q.state)}
      codeChallenge={one(q.code_challenge)}
      codeChallengeMethod={one(q.code_challenge_method)}
    />
  );
}
