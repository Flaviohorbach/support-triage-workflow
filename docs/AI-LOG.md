# AI log: what the agent got wrong

Built with a coding agent (Claude Code), as in [project 5](https://github.com/Flaviohorbach/legacy-storefront-refactor). These happened while building this project.

### 1. A panel that only noticed what it already knew

The panel checked the queue only while one of its own messages was pending. A message from Telegram or from another visitor would never appear until a reload, and a retry would wait for the GitHub schedule. **Caught by:** sending test messages from a script instead of the form: the retry that should run after 30 s never ran. **Fix:** the panel checks every 15 s, and every 4 s while something is pending.

### 2. The same number format mistake as in project 8

Times showed as "3.8 s" in a Portuguese page. Project 8 had the same bug with money, and its fix did not carry over. **Caught by:** reading the panel's text. **Fix:** one Brazilian formatter for every duration.

### 3. A test that could not fail for the right reason

A test meant to prove the Trello token never goes in the URL used the token "t", which every URL contains. It failed, but a token that happened not to appear would have passed for the wrong reason. **Caught by:** the test run. **Fix:** a distinctive fake token, and a check that it is in the header.

### 4. Calling a webhook before n8n was ready

The first call to the n8n workflow returned 404, and the agent started looking for a problem in the workflow file. n8n answers its health check before it activates workflows. **Caught by:** the debug log, which showed no error, and a second call that worked. **Fix:** none in the code. Wait for the webhook itself, not for the health check.

### 5. A readiness check that ran the workflow

That readiness loop posted an empty body to the webhook, which ran the whole workflow, failed and triggered the error workflow. No quota was spent, because the app rejects an empty message before calling the model. **Caught by:** an extra failed run in the n8n log. **Fix:** a lesson for the next tool: a health check must not have side effects.

## What needed a human

- Choosing code on Vercel plus an n8n version, to have a live demo and still compare with n8n.
- Choosing Telegram and Trello, and creating the bot, the Trello key and the accounts.
