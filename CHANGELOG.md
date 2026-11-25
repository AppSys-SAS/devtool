# Changelog

## [1.0.1](https://github.com/AppSys-SAS/devtool/compare/v1.0.0...v1.0.1) (2026-11-25)


### Bug Fixes

* **cli:** serve the workspace interface when run from source ([c083903](https://github.com/AppSys-SAS/devtool/commit/c0839039a3da2094ae8b65b6849730e6ab36b129))


### Miscellaneous Chores

* release 1.0.1 ([edba24e](https://github.com/AppSys-SAS/devtool/commit/edba24edb07763b997ceb7961b189bcaaef04225))

## [1.0.0](https://github.com/AppSys-SAS/devtool/compare/v0.1.1...v1.0.0) (2026-11-25)


### ⚠ BREAKING CHANGES

* **environment:** the top-level cdn section is removed; declare environment.backends.<name> { type: cdn, url } instead.
* **auth:** cdn.openid is no longer read; move issuer, clientId, name and callbackPort to a top-level auth section (type: openid).

### Features

* add file spaces, scripts, prompts, access rules and local DNS ([93f7cf8](https://github.com/AppSys-SAS/devtool/commit/93f7cf82c87c748925f319967bdb82cb06162ac4))
* add issues, agent prompts and pull request and issue pages ([44c2759](https://github.com/AppSys-SAS/devtool/commit/44c275900f76c478bcb49710a65bf2b0d4cb74c1))
* **auth:** sign in with an auth section and add auth value blocks ([7f2e8eb](https://github.com/AppSys-SAS/devtool/commit/7f2e8eb9280e7fa5e79079f1eac42c908788938b))
* **cdn:** sign in with Authelia and use the devtool files of the CDN ([d01d6cc](https://github.com/AppSys-SAS/devtool/commit/d01d6ccacb73dab18549978a31a21ce848e7eb3b))
* **cli:** add devtool skills sync to install the agent skills ([e80b388](https://github.com/AppSys-SAS/devtool/commit/e80b3888b64bfd5189b37770359acc447582c341))
* config-driven integrations and devtool configuration out of the repo ([bc0a49c](https://github.com/AppSys-SAS/devtool/commit/bc0a49c2cc65a4dab30eca0d8b4c9983395548c5))
* **config:** add helpdesk ([7f0a5b6](https://github.com/AppSys-SAS/devtool/commit/7f0a5b650734149afb4aed1690c3720f282400d0))
* **config:** give sections without a path a default sectionPath ([d307a89](https://github.com/AppSys-SAS/devtool/commit/d307a891bb222a827f7f580172efdd0284bafb52))
* configure the name, display name and icon of the devtool ([0e1ae68](https://github.com/AppSys-SAS/devtool/commit/0e1ae68278b979a48d40eed1cbb7a93a49797cb7))
* drizzle ([23e84f3](https://github.com/AppSys-SAS/devtool/commit/23e84f3a25f8c30a54e8724eff66a6ba6e09990b))
* **env:** add docker compose global env ([334593d](https://github.com/AppSys-SAS/devtool/commit/334593d7188b52ee5407bdb13ae08d92f337e930))
* **env:** back up and restore MongoDB databases ([89c0d8e](https://github.com/AppSys-SAS/devtool/commit/89c0d8eff91bc9c07147080e170b3438d4c01980))
* **env:** back up and restore Redis databases ([b9bd8db](https://github.com/AppSys-SAS/devtool/commit/b9bd8db39644afac7123ef3ed26c69652cf0bb40))
* **environment:** store the environment on configurable backends ([6c325d6](https://github.com/AppSys-SAS/devtool/commit/6c325d646728776ea995235d15ac6c20dc4ac73a))
* **env:** merge YAML files key by key on pull and push ([85e5bb1](https://github.com/AppSys-SAS/devtool/commit/85e5bb1e288be30907d2ec8b29ba0d7331ccb94b))
* **env:** pull and push some key groups of a Redis database ([cec2ad8](https://github.com/AppSys-SAS/devtool/commit/cec2ad8c2838ee2265bddba89e2726e0ed4575ae))
* **env:** show certificates and private keys of the environment ([217961b](https://github.com/AppSys-SAS/devtool/commit/217961b7416c4ea1b268cfcf95bbc4d809f69b30))
* **env:** sync the development environment with the CDN ([e5e53fa](https://github.com/AppSys-SAS/devtool/commit/e5e53fab9f92ad6f34d0edb1e9ea40af802a7ef5))
* **env:** sync the devtool configuration only when declared ([a3b4087](https://github.com/AppSys-SAS/devtool/commit/a3b4087662bf49b638f13244e485ec49099807e8))
* **files:** show hidden files on demand, credit libraries, ignore agent files ([86a29ca](https://github.com/AppSys-SAS/devtool/commit/86a29ca52ff8287cd8bd85ff838900c86be6c4d1))
* give the devtool its own blueprint icon ([35fb3a5](https://github.com/AppSys-SAS/devtool/commit/35fb3a57a7b97b6bbeb6fd656c0e6e689a79ea09))
* HTTP/2, port conflicts and key-by-key .env/.json sync ([6478207](https://github.com/AppSys-SAS/devtool/commit/64782073f292a37f302bcf41bd269e796a54dfc8))
* **lb:** conditional tls ([1111c3b](https://github.com/AppSys-SAS/devtool/commit/1111c3b823a332a6383f786c351fc3c5d4b24a28))
* **lb:** urls ([f732010](https://github.com/AppSys-SAS/devtool/commit/f7320108eda91be17b99a10b4eb0537b2d22d8c1))
* let sections declare integrations and order the sidebar ([4012bfe](https://github.com/AppSys-SAS/devtool/commit/4012bfe5dac46b3c989a583d19e5498fd9c1a620))
* list pull requests, start review agents and edit agent skills ([4142fa0](https://github.com/AppSys-SAS/devtool/commit/4142fa06ba615297a984f33748bee77475835aec))
* **mcp:** add permission categories and batch edits ([01986d9](https://github.com/AppSys-SAS/devtool/commit/01986d98c3076e7a62b48ff7b7dd41e2a8baec0c))
* **mcp:** edit permissions from the agents page ([212c181](https://github.com/AppSys-SAS/devtool/commit/212c181ded26e36dc7b1f404b9dd298778b35059))
* **mcp:** fine-tune the permissions of each item of the environment ([7473a99](https://github.com/AppSys-SAS/devtool/commit/7473a99ce16382882abce5aec1dc91994fb49d05))
* **mcp:** let agents drive terminals, files and environment ([ec6acaf](https://github.com/AppSys-SAS/devtool/commit/ec6acaf42e9d84ce85c3bcb494fe40e1e91fe216))
* **mcp:** serve agent skills over MCP and document coding agents ([2e37635](https://github.com/AppSys-SAS/devtool/commit/2e376356ac60d641f0faa19174c051bc119ecfa0))
* **mcp:** show agents by their display name and icon ([e11d160](https://github.com/AppSys-SAS/devtool/commit/e11d160c61d587eb3b4f275a60fb2b5f5bd3c3b5))
* **mcp:** show the arguments and waits of the calls in the history ([ba00e1b](https://github.com/AppSys-SAS/devtool/commit/ba00e1b20aac79a59d7e72f86c768964a7530628))
* merge XML and TOML files key by key, rule agent reads of forges ([371786c](https://github.com/AppSys-SAS/devtool/commit/371786cdee2d2a27232a2e4534d73b1d9bd09df7))
* **pull-requests:** enable agent reviews with agentReview, off by default ([5d062c7](https://github.com/AppSys-SAS/devtool/commit/5d062c7630711fbef97a181230aedf12ff9bbe76))
* renew load balancer certificates and choose the sidebar parts ([0ea68e5](https://github.com/AppSys-SAS/devtool/commit/0ea68e55e66c851b654cc426ea11adba579b69b1))
* **server:** run the dev load balancer in its own process ([1b77d4e](https://github.com/AppSys-SAS/devtool/commit/1b77d4e9af8563d7d4da1dc85cecbb17c6558c41))
* **server:** value blocks and per-run 1Password authorization ([bda53f1](https://github.com/AppSys-SAS/devtool/commit/bda53f1f178e8fe276929d46e39eda041e2057e2))
* **shell:** real shell exec ([92fd6be](https://github.com/AppSys-SAS/devtool/commit/92fd6be629fda0a634a445a04e860eb88a6e0a9b))
* **shell:** set shell ([1287b91](https://github.com/AppSys-SAS/devtool/commit/1287b91148369cfbd8658aae8dd0dd0939b318c2))
* **shell:** unreads ([bcb2191](https://github.com/AppSys-SAS/devtool/commit/bcb21912cf08d9a6bebcbba4111ac6b1117023cc))
* **ui:** edit environment configs in an integrated Monaco editor ([2e838b0](https://github.com/AppSys-SAS/devtool/commit/2e838b0488f9c5e191da19b9c30aa1fbe3d5744a))
* **ui:** give the MCP setup of each agent in the connection tab ([ad50976](https://github.com/AppSys-SAS/devtool/commit/ad50976420807ed2585fdba0834054f62c5a7b7e))
* **ui:** keep embedded integrations loaded and let them be reloaded ([5425884](https://github.com/AppSys-SAS/devtool/commit/5425884a508c0eb06e6bf7093cbfd52543d90422))
* **ui:** pull and push the environment from an Environment page ([b2ca717](https://github.com/AppSys-SAS/devtool/commit/b2ca7173193dec4b4a987724c423bd26bd5e35a6))
* **ui:** pull the devtool configuration from an empty Environment page ([eafb477](https://github.com/AppSys-SAS/devtool/commit/eafb477fc9709a26102157c8903ecab49d7d7cf1))
* **ui:** show the signed-in developer with sign-in and sign-out ([d75b270](https://github.com/AppSys-SAS/devtool/commit/d75b27077f258ba2ed4a8183477f2b2ef59a611b))
* **ui:** split the agents page into tabs ([52cf49b](https://github.com/AppSys-SAS/devtool/commit/52cf49bb3daa3e35e80b4e89b75c86c62337b374))
* **ui:** start and stop a whole section from the sidebar ([9a91c0f](https://github.com/AppSys-SAS/devtool/commit/9a91c0fd71130107b3f0873cb4bdc688ceff929f))
* unify scripts and commands with inputs asked at start ([8167675](https://github.com/AppSys-SAS/devtool/commit/816767524de6a8fe5b6b1c486175b220540edb57))


### Bug Fixes

* **cli:** stop pulling configurations when the server starts ([56de988](https://github.com/AppSys-SAS/devtool/commit/56de9883081982b762ba66b9e9ff4ef85c01f107))
* config ([df5d0fa](https://github.com/AppSys-SAS/devtool/commit/df5d0fa44d12585216398378068be44e8a472780))
* config ([d9bdb30](https://github.com/AppSys-SAS/devtool/commit/d9bdb30efe0dfb2d9716596fa811436375d8a446))
* **config:** api url ([28f40c1](https://github.com/AppSys-SAS/devtool/commit/28f40c193fad5605d7d5b9ac1eb9517a1bb0c5aa))
* **config:** config reload ([6cb9eca](https://github.com/AppSys-SAS/devtool/commit/6cb9eca6d5e66147acf0228b1fe26d77b0d1b437))
* **config:** paths ([091710b](https://github.com/AppSys-SAS/devtool/commit/091710b23b2b57eef8181e33e08a95cfca7b8b74))
* **config:** place uncategorized projects and inherit project env ([adc6a9f](https://github.com/AppSys-SAS/devtool/commit/adc6a9fabc75e64202484e25ef7a01b54c19dc21))
* **config:** section paths ([cb07787](https://github.com/AppSys-SAS/devtool/commit/cb0778724f0331178103f3d1f75728bc6e14ea16))
* **deps:** make the node-pty spawn helper executable ([529f8f1](https://github.com/AppSys-SAS/devtool/commit/529f8f1c018d91084e95e8be261be44a6d49f43b))
* **env:** forget a finished run when its panel is closed ([92d5961](https://github.com/AppSys-SAS/devtool/commit/92d59618713917ba5c3a29916bd06ae353a2e0f3))
* lb, create certs ([1005d39](https://github.com/AppSys-SAS/devtool/commit/1005d39d51b818e21ddfa3751aca7cc608b5ddc3))
* **mcp:** describe a started terminal after its wait ([1b50300](https://github.com/AppSys-SAS/devtool/commit/1b50300577059f560d0c92faef7defcb1a3d3854))
* **mcp:** let the start and stop of a section be granted ([3917090](https://github.com/AppSys-SAS/devtool/commit/3917090ca787f1cf1d09efa586c57504701484ec))
* **mcp:** withdraw abandoned calls and close sessions of stopped agents ([643147c](https://github.com/AppSys-SAS/devtool/commit/643147ca203fe7266d6166f5beb5b637c96fd2a7))
* **proxy:** certs ([2e48bd9](https://github.com/AppSys-SAS/devtool/commit/2e48bd963e9b03c4ff5ecda48f41f51a4c6e2381))
* **proxy:** tls keepalive ([6abf89b](https://github.com/AppSys-SAS/devtool/commit/6abf89b1b64869b6b0c9afe9168a46ae0ec47826))
* resolve the ESLint findings and the bugs found by tests ([501105b](https://github.com/AppSys-SAS/devtool/commit/501105b2fcd9c85a3325752f98d4dc299dd66651))
* **server:** accept 1Password references whose names hold spaces ([dba4862](https://github.com/AppSys-SAS/devtool/commit/dba48628708ab89360ddd58a325792e29e604418))
* **server:** wait for a stopped process to exit before restarting it ([8b1514e](https://github.com/AppSys-SAS/devtool/commit/8b1514e3f8c40896e074186a0aff7886e51fe86e))
* **shell:** custom kill signals ([4a008f9](https://github.com/AppSys-SAS/devtool/commit/4a008f9e2a6db40475fc111e7d9d9c8ae36c38b3))
* streamview ([e5d422b](https://github.com/AppSys-SAS/devtool/commit/e5d422b57270333b8ca64bd031d2ddc11779c8da))
* **ui:** align the agent and shell rows of the permissions ([7391ae0](https://github.com/AppSys-SAS/devtool/commit/7391ae014922bccb5168f7feca6ae7ae03dba424))
* **ui:** keep request notifications and send them from one tab ([b6ca88e](https://github.com/AppSys-SAS/devtool/commit/b6ca88ec7e980f5baaa8eecb5230e4ff60cc1511))
* **ui:** leave the WebSocket handshake timeout to the browser ([2111124](https://github.com/AppSys-SAS/devtool/commit/2111124714a33bb46090f14bb7e2afee48c710ce))
* **ui:** open a tab when the agents page has none ([1331369](https://github.com/AppSys-SAS/devtool/commit/1331369afa45fbd61ee5b73ccbd85579c8bf008c))
* **ui:** restore sidebar scrolling ([4c84e7f](https://github.com/AppSys-SAS/devtool/commit/4c84e7f4fcfe1334111201cffff765226d30c4d1))
* **ui:** serve fonts and icons locally and apply theme before paint ([470c08c](https://github.com/AppSys-SAS/devtool/commit/470c08ce80f559f7a78314d22937419696cd99da))
* **ui:** utils ([73cb4ce](https://github.com/AppSys-SAS/devtool/commit/73cb4ce5482e3f230eb5bbfc33f8df4748216335))
* **vite:** autorefresh ui ([0ed80a7](https://github.com/AppSys-SAS/devtool/commit/0ed80a747c0df9e922310da1297a7dc9daf9286b))
* **xterm:** size and scrollbar ([5bcecae](https://github.com/AppSys-SAS/devtool/commit/5bcecae3e31f673cc4473ae334303dfb122703ed))
* **xterm:** update, fix viewport ([1f2b852](https://github.com/AppSys-SAS/devtool/commit/1f2b8526fdf9c94eab2db0cb37c0c0ce091111ae))


### Miscellaneous Chores

* release 1.0.0 ([32c407e](https://github.com/AppSys-SAS/devtool/commit/32c407ea4aca15208399df7ca7439648eb4541d2))
* release 1.0.0 ([d7e60ce](https://github.com/AppSys-SAS/devtool/commit/d7e60ceaa9df77faecddabb9bbc919e927922b8f))
