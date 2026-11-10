# Interrupted attempt: permission rules did not match

The first Claude Code attempt stopped in pair 2. The prompt told the agent to use
the quoted absolute Node path. The agent spelled it `C:/nvm4w/nodejs/node.exe`, but
the allow rule used backslashes, so every doktimoi call needed approval and was
refused. The agent then used Grep and Read, which need no approval, and the audit
flagged 40 bypasses.

Pair 1 had completed: baseline 1,092,632 tokens in 134.8 s, Doktimoi 564,586 tokens in
113.5 s. Those runs are excluded from the comparison, because the next run changed the
prompt and permissions. That run asks for plain `node`, and in the treatment arm it
denies Grep and Read of the corpus. Index builds here took about 147 s with Windows
Defender real-time protection on.
