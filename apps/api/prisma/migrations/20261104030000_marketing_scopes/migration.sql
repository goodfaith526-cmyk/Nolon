-- The marketing summary scopes (docs/plans/11): new values of the API key scope enum only.
ALTER TYPE "api_scope" ADD VALUE 'MARKETING_READ';
ALTER TYPE "api_scope" ADD VALUE 'MARKETING_REVENUE_READ';
