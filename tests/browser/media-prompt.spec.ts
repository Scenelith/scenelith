import {readFileSync} from 'node:fs';
import path from 'node:path';
import {build} from 'esbuild';
import {test,expect} from '@playwright/test';

test('viewer shows prompt once and can expand, read the end, and collapse on desktop and mobile',async({page})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('https://scenelith.test/api/assets/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#537a92"/></svg>'}));
 const css=(readFileSync('src/app/globals.css','utf8')+readFileSync('src/app/theme.css','utf8')).replace(/@import[^;]+;/g,'');
 await page.route('https://scenelith.test/',route=>route.fulfill({contentType:'text/html',body:`<style>${css}</style><div id="root"></div>`}));
 const fixture=(await build({entryPoints:['tests/browser/fixtures/media-prompt.tsx'],bundle:true,write:false,platform:'browser',jsx:'automatic',tsconfig:path.resolve('tsconfig.json'),define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
 await page.setViewportSize({width:1440,height:1000});await page.goto('https://scenelith.test/');await page.addScriptTag({content:fixture});
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  const prompt=page.locator('.media-viewer-prompt');await expect(prompt).toHaveCount(1);
  await expect(page.locator('.media-viewer-context')).not.toContainText('ceramic mug');
  const show=page.getByRole('button',{name:'Show full prompt',exact:true});await expect(show).toBeVisible();await show.click();
  await expect(page.getByRole('button',{name:'Show less',exact:true})).toHaveAttribute('aria-expanded','true');
  expect(await prompt.evaluate(node=>node.scrollHeight<=node.clientHeight+1)).toBe(true);
  await expect(prompt).toContainText('The last sentence must remain readable.');
  expect(await page.locator('.media-viewer').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.screenshot({path:`/tmp/scenelith-media-prompt-${width}.png`});
  await page.getByRole('button',{name:'Show less',exact:true}).click();await expect(show).toBeVisible();
 }
 expect(errors).toEqual([]);
});
