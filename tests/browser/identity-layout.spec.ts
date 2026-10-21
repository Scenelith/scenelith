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

for (const zoom of [.75,1,2]) test(`Canvas identity type cards contain their labels at zoom ${zoom}`,async({page})=>{
  const {build}=await import('esbuild');
  const bundle=await build({entryPoints:['tests/browser/fixtures/add-to-identity.tsx'],bundle:true,write:false,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
  const css=readFileSync('src/app/globals.css','utf8')+readFileSync('src/app/theme.css','utf8');
  await page.setViewportSize({width:1440,height:1100});
  await page.setContent(`<style>${css}</style><div id="root" style="transform:scale(${zoom});transform-origin:top left"></div><output id="result"></output>`);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  await page.getByRole('button',{name:'Add generated image to identity'}).click();
  const types=page.getByRole('radiogroup',{name:'Identity type'});
  const boxes=await types.getByRole('radio').evaluateAll(nodes=>nodes.map(node=>({box:node.getBoundingClientRect().toJSON(),text:node.querySelector('span')!.getBoundingClientRect().toJSON()})));
  expect(boxes).toHaveLength(2);
  for(const {box,text} of boxes){expect(box.width).toBeGreaterThan(100*zoom);expect(text.left).toBeGreaterThanOrEqual(box.left);expect(text.right).toBeLessThanOrEqual(box.right);expect(text.bottom).toBeLessThanOrEqual(box.bottom);}
  expect(boxes[0].box.right).toBeLessThanOrEqual(boxes[1].box.left);
  await types.getByRole('radio',{name:/Before \/ After/}).click();
  await expect(types.getByRole('radio',{name:/Before \/ After/})).toHaveAttribute('aria-checked','true');
  await page.getByRole('textbox',{name:'Identity name'}).fill('Canvas identity');
  await page.getByRole('radiogroup',{name:'Reference group'}).getByRole('radio',{name:'After',exact:true}).click();
  await page.getByRole('button',{name:'Create & add to After'}).click();
  await expect(page.locator('#result')).toHaveText('Canvas identity:after');
});
