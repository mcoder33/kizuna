# External calendar and Telegram request limits

CalDAV uses native Node HTTP(S) with certificate/hostname verification. Every target (including saved href, discovery, REPORT and redirects) is validated against its account server origin before credentials are attached. The socket lookup validates all returned A/AAAA addresses and pins those exact addresses; nonpublic IPv4/IPv6, metadata, mapped-private and transition addresses are rejected. No pooled socket or separate preflight fetch bypasses lookup.

Custom CalDAV accounts cannot cross origins or downgrade HTTPS. The iCloud preset with bootstrap `https://caldav.icloud.com` additionally trusts only HTTPS `pNN-caldav.icloud.com` / `pNNN-caldav.icloud.com` on the default port, because Apple discovery returns those calendar shards. Other Apple subdomains, suffix lookalikes and custom accounts receive no exception. All redirects are revalidated, with at most three hops and a shared byte/deadline budget per request chain.

Local CalDAV fixtures require **both** `NODE_ENV=test` (or `development`) and `PAGENT_CALDAV_ALLOW_LOCALHOST=1`. Only `localhost`, `127.0.0.1` and `::1` targets resolving exclusively to loopback may use HTTP. The flag never permits LAN, metadata or public-IP answers for localhost; production ignores it. There is no automatic localhost allowance.

| Response | Maximum bytes | Deadline |
| --- | --- | --- |
| CalDAV response / redirect chain | 8 MiB combined | 20 seconds; discovery shares one deadline |
| Google API response | 4 MiB | 20 seconds including body |
| Google calendar/event pagination | 16 MiB combined, 40 pages; repeated tokens rejected | 20 seconds including series lookups |
| Telegram API JSON | 2 MiB | 20 seconds |
| Telegram attachment | Existing attachment limit, default 10 MiB | 20 seconds including getFile |
| Telegram long polling | 2 MiB | Requested poll timeout plus 15 seconds |

Advertised Content-Length and actual streamed bytes are checked before text decoding, JSON/XML parsing or attachment storage. Overflow/deadline cancels the reader and aborts the request. Native CalDAV requests negotiate identity encoding and reject unexpected compressed bodies. Google/Telegram reject redirects and use their existing fetch transport. Test-only injected fetch fixtures still run the origin and body checks; the production CalDAV default always uses pinned native connections.

Displayed calendar links accept only absolute HTTP(S) URLs without userinfo/control characters. API presentation and browser rendering both filter unsafe links from old cached records, without rewriting records or user text. Those presentation URLs never define trusted outbound CalDAV origins.
