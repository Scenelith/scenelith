import {readFileSync} from 'node:fs';
import path from 'node:path';
import {build} from 'esbuild';
import {test,expect} from '@playwright/test';

test('viewer shows prompt once and can expand, read the end, and collapse on desktop and mobile',async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write'], {origin:'https://scenelith.test'});
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('https://scenelith.test/api/assets/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><rect width="800" height="800" fill="#537a92"/></svg>'}));
 const css=(readFileSync('src/app/globals.css','utf8')+readFileSync('src/app/theme.css','utf8')).replace(/@import[^;]+;/g,'');
 await page.route('https://scenelith.test/',route=>route.fulfill({contentType:'text/html',body:`<style>${css}</style><style>.host {font-size:16px}.host button{font:inherit}.host a{color:inherit}.host :is(button,a):focus-visible{outline:2px solid #78e0bd;outline-offset:5px}</style><div id="root" class="host"></div>`}));
 const fixture=(await build({entryPoints:['tests/browser/fixtures/media-prompt.tsx'],bundle:true,write:false,platform:'browser',jsx:'automatic',tsconfig:path.resolve('tsconfig.json'),define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
 await page.setViewportSize({width:1440,height:1000});await page.goto('https://scenelith.test/');await page.addScriptTag({content:fixture});
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  const prompt=page.locator('.media-viewer-prompt');await expect(prompt).toHaveCount(1);
  await expect(page.locator('.media-viewer-context')).not.toContainText('ceramic mug');
  const show=page.getByRole('button',{name:'Show more',exact:true});await expect(show).toBeVisible();
  expect(await show.evaluate(node=>parseFloat(getComputedStyle(node).fontSize))).toBeLessThanOrEqual(width===390?11:9);
  await show.focus();await expect(show).toHaveCSS('outline-style','none');await show.click();
  await expect(page.getByRole('button',{name:'Show less',exact:true})).toHaveAttribute('aria-expanded','true');
  expect(await prompt.evaluate(node=>node.scrollHeight<=node.clientHeight+1)).toBe(true);
  await expect(prompt).toContainText('The last sentence must remain readable.');
  expect(await page.locator('.media-viewer').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  const copy=page.getByRole('button',{name:'Copy prompt',exact:true});await copy.click();
  await expect(page.getByRole('button',{name:'Prompt copied',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>navigator.clipboard.readText())).toBe(await prompt.textContent());
  await expect(page.getByLabel('Media aspect ratio',{exact:true})).toHaveText('1:1');
  await expect(page.getByLabel('Media aspect ratio',{exact:true})).toHaveAttribute('title','800 × 800 pixels');
  const download=page.getByRole('link',{name:'Download current media',exact:true});
  expect(await download.evaluate(node=>getComputedStyle(node).color)).toBe(await page.locator('.media-viewer-prompt-toggle').evaluate(node=>getComputedStyle(node).color));
  await page.screenshot({path:`/tmp/scenelith-media-prompt-${width}.png`});
  await page.getByRole('button',{name:'Show less',exact:true}).click();await expect(show).toBeVisible();
  await expect(page.getByRole('button',{name:'Copy prompt',exact:true})).toBeVisible();
 }
 expect(errors).toEqual([]);
});

for (const sample of [
 {name:'portrait image',kind:'image',width:800,height:1200,ratio:'2:3'},
 {name:'landscape image',kind:'image',width:1200,height:800,ratio:'3:2'},
 {name:'video metadata',kind:'video',width:32,height:32,ratio:'1:1'},
]) test(`viewer uses actual ${sample.name} dimensions instead of the requested ratio`,async({page})=>{
 const css=(readFileSync('src/app/globals.css','utf8')+readFileSync('src/app/theme.css','utf8')).replace(/@import[^;]+;/g,'');
 await page.route('https://scenelith.test/api/assets/**',route=>route.fulfill(sample.kind==='video'
  ? {contentType:'video/mp4',body:readFileSync('tests/browser/fixtures/playback.mp4')}
  : {contentType:'image/svg+xml',body:`<svg xmlns="http://www.w3.org/2000/svg" width="${sample.width}" height="${sample.height}"><rect width="100%" height="100%" fill="#537a92"/></svg>`}));
 await page.route('https://scenelith.test/?kind='+sample.kind,route=>route.fulfill({contentType:'text/html',body:`<style>${css}</style><div id="root"></div>`}));
 const fixture=(await build({entryPoints:['tests/browser/fixtures/media-prompt.tsx'],bundle:true,write:false,platform:'browser',jsx:'automatic',tsconfig:path.resolve('tsconfig.json'),define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
 await page.goto('https://scenelith.test/?kind='+sample.kind);await page.addScriptTag({content:fixture});
 await expect(page.getByLabel('Media aspect ratio',{exact:true})).toHaveText(sample.ratio);
 await expect(page.getByLabel('Media aspect ratio',{exact:true})).toHaveAttribute('title',`${sample.width} × ${sample.height} pixels`);
 await expect(page.getByText('Original ratio',{exact:true})).toHaveCount(0);
});
