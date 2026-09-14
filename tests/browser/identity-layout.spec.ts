import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

for (const width of [1440, 1000, 600]) test(`identity reference panels stay inside their cards at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  const card = (index: number) => `<article class="identity-record identity-page-record"><div class="identity-record-title"><div class="identity-avatar">A</div><span><strong>Identity ${index}</strong><small>Notes</small><b>22 references total</b></span></div><div class="identity-states identity-page-states">${["before", "after"].map((state) => `<section class="identity-state-panel ${state}-state"><header><span><b>${state}</b></span></header><div class="identity-asset-strip">${Array.from({length: 12}, (_, i) => `<div class="identity-asset-card"><button class="identity-asset-select">${i + 1}</button></div>`).join("")}</div></section>`).join("")}</div></article>`;
  await page.setContent(`<style>${readFileSync("src/app/globals.css", "utf8")}${readFileSync("src/app/theme.css", "utf8")}</style><div class="identity-library-body identity-page-body" style="height:600px">${Array.from({length:5}, (_,i)=>card(i)).join("")}</div>`);
  const bounds = await page.locator(".identity-page-record").evaluateAll((cards) => cards.map((card) => ({ box: card.getBoundingClientRect().toJSON(), panels: Array.from(card.querySelectorAll(".identity-state-panel")).map((panel) => panel.getBoundingClientRect().toJSON()) })));
  for (const [i, card] of bounds.entries()) {
    for (const panel of card.panels) { expect(panel.bottom).toBeLessThanOrEqual(card.box.bottom); expect(panel.right).toBeLessThanOrEqual(card.box.right); }
    if (i) expect(card.box.top).toBeGreaterThanOrEqual(bounds[i-1].box.bottom + 10);
  }
  expect(await page.locator('.identity-page-body').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
});
