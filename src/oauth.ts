/** OAuth client identities the CLIs themselves use; we refresh with the same ones. */
export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
export const CLAUDE_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token'
export const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'

/** Claude's consent page for the Claude Code client; the authorization code lands on CLAUDE_REDIRECT_URL. */
export const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
export const CLAUDE_REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback'
/**
 * What `claude setup-token` asks for (Claude CLI 2.1.301, chunk uQs → the
 * login component's `expiresIn`): the token exchange carries
 * `expires_in: 31536000` and the server mints a bearer that lasts a year.
 * The same field rides a refresh_token grant (`claude auth login` with
 * CLAUDE_CODE_OAUTH_REFRESH_TOKEN), so a grant we hold can mint one too.
 */
export const ONE_YEAR_S = 31_536_000
/** The CLI's setup-token asks for `user:inference` alone; `user:profile` lets the token name its account and read usage. */
export const STATIC_SCOPES = ['user:profile', 'user:inference']
export const INFERENCE_ONLY_SCOPES = ['user:inference']
