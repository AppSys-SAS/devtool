---
layout: page
title: Configurator
description: Build a devtool configuration from forms, with a live, validated YAML preview.
---

<div class="configurator-page">

# Configurator

Fill in the forms and copy or download the result. The preview is checked against the
[configuration schema](/configuration/overview#editor-completion) as you type, so a typo or a missing
setting shows up right away. Every generated file starts with a line that gives your editor completion
and checks for the rest of the settings.

- **One file** keeps the shared settings in `config.yml`.
- **One file per project** writes `config/sections.yml` and a `projects/<slug>.yml` per project, linked
  from `config.yml` by [`include`](/configuration/overview#splitting-the-configuration): handy when a team
  owns many projects.
- Your workspace always goes to `config.local.yml`, the personal file that is never shared.

The forms cover the settings most teams need. Inputs, automation, permissions by project and the other
advanced settings are written by hand: use **Import** to load your file back and keep editing it here.

<ClientOnly>
  <configurator />
</ClientOnly>

</div>

<style>
.configurator-page {
  max-width: 1376px;
  margin: 0 auto;
  padding: 32px 24px 96px;
}

.configurator-page h1 {
  font-family: var(--vp-font-family-heading);
  font-size: 32px;
  font-weight: 700;
  margin-bottom: 16px;
}

.configurator-page p,
.configurator-page li {
  max-width: 760px;
  line-height: 1.7;
  color: var(--vp-c-text-2);
}

.configurator-page a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
}

.configurator-page ul {
  padding-left: 20px;
  list-style: disc;
}
</style>
