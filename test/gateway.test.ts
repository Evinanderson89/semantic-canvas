import { beforeAll, afterAll, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { CompanyAuth, checkAccessPrincipals, identityOf, type AccessConfig } from '../src/security/auth.ts';
let provider:Server,server:Server,withDefault:Server,issuer:string,url:string,urlWithDefault:string,keys:Awaited<ReturnType<typeof generateKeyPair>>,auth:CompanyAuth;
const bindings:AccessConfig['bindings']=[{group:'data-users',role:'viewer',principal:'emea',sources:['sample']}];
async function serve(access:AccessConfig){
 const auth=new CompanyAuth({mode:'gateway',publicUrl:'http://semantic-canvas.apps.localhost:10000',issuer,clientId:'gateway-portal',jwksUri:issuer+'/jwks',portalUrl:'http://apps.localhost:10000',scopes:'openid',sessionSeconds:3600,access});await auth.start();
 const app=express();auth.mount(app);app.use('/api',auth.guard);app.all('/api/dashboards',(_q,r)=>r.json({ok:true}));app.get('/api/identity',(q,r)=>r.json({identity:identityOf(q),forwarded:auth.forwarded(q)}));const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 return {auth,server,url:`http://127.0.0.1:${(server.address() as any).port}`};
}
beforeAll(async()=>{
 keys=await generateKeyPair('RS256');const jwk={...await exportJWK(keys.publicKey),kid:'gateway-test',alg:'RS256'};
 provider=createServer((_q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({keys:[jwk]}));});await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));issuer=`http://127.0.0.1:${(provider.address() as any).port}`;
 ({auth,server,url}=await serve({groupsClaim:'groups',bindings}));
 ({server:withDefault,url:urlWithDefault}=await serve({groupsClaim:'groups',default:{role:'editor',principal:'admin',sources:['*']},bindings}));
});
afterAll(async()=>{await Promise.all([server,withDefault,provider].map(s=>new Promise<void>(r=>s.close(()=>r()))));});
async function token(groups=['data-users'],aud='gateway-portal',expires='5m'){return new SignJWT({groups,name:'Casey'}).setProtectedHeader({alg:'RS256',kid:'gateway-test'}).setIssuer(issuer).setSubject('casey').setAudience(aud).setExpirationTime(expires).sign(keys.privateKey);}
it('verifies Gateway cookies and retains the configured RLS principal and sources',async()=>{const cookie=`gw_session=${await token()}`;const session=await (await fetch(url+'/api/auth/session',{headers:{cookie}})).json();expect(session.authenticated).toBe(true);expect(session.canEdit).toBe(false);const body=await(await fetch(url+'/api/identity',{headers:{cookie,'x-sc-principal':'admin','x-gateway-groups':'data-admins'}})).json();expect(body.identity.principal).toBe('emea');expect(body.identity.sources).toEqual(['sample']);expect(body.forwarded.cookie).toBe(cookie);expect(body.forwarded.csrf).toBe(session.csrf);});
it('denies spoofed gateway identity headers without a verified JWT',async()=>{expect((await fetch(url+'/api/identity',{headers:{'x-gateway-user':'admin','x-gateway-groups':'data-users'}})).status).toBe(401);});
it('accepts the same Gateway token as a bearer for non-browser clients, cookie winning when both are present',async()=>{const jwt=await token();const asBearer=await (await fetch(url+'/api/auth/session',{headers:{authorization:`Bearer ${jwt}`}})).json();expect(asBearer.authenticated).toBe(true);expect(asBearer.user.role).toBe('viewer');expect((await fetch(url+'/api/identity',{headers:{authorization:'Bearer not-a-jwt'}})).status).toBe(401);const bad=await token(['other']);const both=await (await fetch(url+'/api/auth/session',{headers:{cookie:`gw_session=${jwt}`,authorization:`Bearer ${bad}`}})).json();expect(both.authenticated).toBe(true);});
it('sends sign-in through the portal refresh with a return address, and names the portal when signed out',async()=>{const r=await fetch(url+'/api/auth/login',{redirect:'manual'});expect(r.status).toBe(302);const to=new URL(r.headers.get('location')!);expect(to.origin).toBe('http://apps.localhost:10000');expect(to.pathname).toBe('/auth/refresh');expect(to.searchParams.get('next')).toBe('http://semantic-canvas.apps.localhost:10000');const out=await (await fetch(url+'/api/auth/session')).json();expect(out.authenticated).toBe(false);expect(out.gatewayUrl).toBe('http://apps.localhost:10000');});
it.each(['wrong-audience','expired','unassigned'])('rejects %s tokens',async(kind)=>{const jwt=await token(kind==='unassigned'?['other']:['data-users'],kind==='wrong-audience'?'another-app':'gateway-portal',kind==='expired'?'-1s':'5m');expect((await fetch(url+'/api/identity',{headers:{cookie:`gw_session=${jwt}`}})).status).toBe(401);});
it('enforces CSRF and viewer restrictions even with valid Gateway identity',async()=>{const cookie=`gw_session=${await token()}`;const s=await(await fetch(url+'/api/auth/session',{headers:{cookie}})).json();expect((await fetch(url+'/api/dashboards',{method:'POST',headers:{cookie}})).status).toBe(403);expect((await fetch(url+'/api/dashboards',{method:'POST',headers:{cookie,'x-sc-csrf':s.csrf}})).status).toBe(403);});
it('reports a current identity only for owners who presented a valid token since start',async()=>{const cookie=`gw_session=${await token()}`;const body=await(await fetch(url+'/api/identity',{headers:{cookie}})).json();expect(auth.currentIdentity(body.identity.id)).toMatchObject({id:body.identity.id,principal:'emea',sources:['sample']});expect(auth.currentIdentity('someone-else')).toBeNull();const team=new CompanyAuth({mode:'team',scopes:'openid',sessionSeconds:300});const session=team.issue({id:'t',name:'T',role:'viewer',principal:'emea',sources:['sample']},{cookie(){}} as any);expect(team.currentIdentity('t')).toMatchObject({id:'t'});session.expires=Date.now()-1;expect(team.currentIdentity('t')).toBeNull();expect(new CompanyAuth({mode:'local',scopes:'openid',sessionSeconds:300}).currentIdentity('t')).toBeNull();});
it('hands sign-out to the portal, which holds the refresh cookie, and still demands the anti-forgery token',async()=>{const cookie=`gw_session=${await token()}`;const s=await(await fetch(url+'/api/auth/session',{headers:{cookie}})).json();expect((await fetch(url+'/api/auth/logout',{method:'POST',headers:{cookie}})).status).toBe(403);const r=await fetch(url+'/api/auth/logout',{method:'POST',headers:{cookie,'x-sc-csrf':s.csrf}});expect(r.status).toBe(200);expect(await r.json()).toEqual({ok:true,redirect:'http://apps.localhost:10000/auth/logout'});expect(r.headers.get('set-cookie')).toMatch(/gw_session=;/);});
it('uses Gateway as the login entry point',async()=>{const r=await fetch(url+'/api/auth/login',{redirect:'manual'});expect(r.headers.get('location')).toMatch(/^http:\/\/apps\.localhost:10000\/auth\/refresh\?next=/);});
it('grants the access default to verified identities in no bound group, and lets bindings win over it',async()=>{
 const unbound=`gw_session=${await token(['self-service'])}`;
 const session=await(await fetch(urlWithDefault+'/api/auth/session',{headers:{cookie:unbound}})).json();
 expect(session).toMatchObject({authenticated:true,canEdit:true,canAdmin:false,user:{role:'editor'}});expect(Object.keys(session.user).sort()).toEqual(['id','name','role']);
 expect((await(await fetch(urlWithDefault+'/api/identity',{headers:{cookie:unbound}})).json()).identity).toMatchObject({role:'editor',principal:'admin',sources:['*']});
 const bound=`gw_session=${await token(['data-users'])}`;
 expect((await(await fetch(urlWithDefault+'/api/identity',{headers:{cookie:bound}})).json()).identity).toMatchObject({role:'viewer',principal:'emea',sources:['sample']});
 expect((await(await fetch(urlWithDefault+'/api/auth/session',{headers:{cookie:bound}})).json()).canEdit).toBe(false);
});
it('keeps refusing unmapped identities when no default is configured',async()=>{
 const cookie=`gw_session=${await token(['self-service'])}`;
 expect((await(await fetch(url+'/api/auth/session',{headers:{cookie}})).json()).authenticated).toBe(false);
 expect((await fetch(url+'/api/identity',{headers:{cookie}})).status).toBe(401);
 expect((await fetch(url+'/api/dashboards',{method:'POST',headers:{cookie}})).status).toBe(401);
});
it('refuses to start when the access default names an unknown RLS principal',async()=>{
 const principals={admin:{},emea:{}};
 expect(()=>checkAccessPrincipals({groupsClaim:'groups',bindings},principals)).not.toThrow();
 expect(()=>checkAccessPrincipals({groupsClaim:'groups',default:{role:'viewer',principal:'emea',sources:['*']},bindings},principals)).not.toThrow();
 expect(()=>checkAccessPrincipals({groupsClaim:'groups',default:{role:'viewer',principal:'nowhere',sources:['*']},bindings},principals)).toThrow(/default references an unknown RLS principal/);
 expect(()=>checkAccessPrincipals({groupsClaim:'groups',bindings:[{...bindings[0],principal:'nowhere'}]},principals)).toThrow(/binding references an unknown RLS principal/);
 const root=await mkdtemp(join(tmpdir(),'sc-gateway-default-'));
 try{
  await writeFile(join(root,'access.yaml'),YAML.stringify({groupsClaim:'groups',default:{role:'viewer',principal:'nowhere',sources:['*']},bindings}));
  await writeFile(join(root,'sources.yaml'),'sources: []\n');
  const env={...process.env,SC_MODE:'gateway',SC_HOST:'127.0.0.1',PORT:'0',SC_PUBLIC_URL:'http://semantic-canvas.apps.localhost:10000',SC_OIDC_ISSUER:'http://localhost:9/',SC_OIDC_CLIENT_ID:'gateway-portal',SC_GATEWAY_JWKS_URI:'http://localhost:9/jwks',SC_GATEWAY_PORTAL_URL:'http://apps.localhost:10000',SC_ACCESS_PATH:join(root,'access.yaml'),SC_DATA_DIR:join(root,'data'),SC_ENV_PATH:join(root,'.env'),SOURCES_PATH:join(root,'sources.yaml'),RLS_PATH:resolve('security/policies.yaml'),SC_SERVE_UI:'false'};
  const child=spawn(process.execPath,['--import','tsx','src/server.ts'],{env,stdio:['ignore','pipe','pipe']});let output='';child.stdout?.on('data',d=>output+=d);child.stderr?.on('data',d=>output+=d);
  const code=await new Promise<number|null>(r=>child.once('exit',r));
  expect(code,output).toBe(1);expect(output).toContain('access default references an unknown RLS principal');expect(output).toContain('"event":"server.start_failed"');
 }finally{await rm(root,{recursive:true,force:true});}
},60_000);
it('reads the signed data policy the gateway adds, ignores a forged or foreign one, and reports it on the session',async()=>{
 const {createHmac}=await import('node:crypto');
 const secret='policy-secret';
 const {auth:a,server:s,url:u}=await serve({groupsClaim:'groups',bindings});
 (a as any).config.policySecret=secret;
 const jwt=await token();
 const rules=[{field:'dim_users.country',mode:'only',values:['GB','DE']}];
 const sign=(payload:object)=>{const body=Buffer.from(JSON.stringify(payload)).toString('base64url');return {body,sig:createHmac('sha256',secret).update(body).digest('base64url')};};
 const now=Math.floor(Date.now()/1000);
 const good=sign({v:1,sub:'casey',app:'semantic-canvas',iat:now,exp:now+120,rules});
 const session=await(await fetch(u+'/api/auth/session',{headers:{cookie:`gw_session=${jwt}`,'x-gateway-policy':good.body,'x-gateway-policy-sig':good.sig}})).json();
 expect(session.policy).toEqual(rules);
 const identity=await(await fetch(u+'/api/identity',{headers:{cookie:`gw_session=${jwt}`,'x-gateway-policy':good.body,'x-gateway-policy-sig':good.sig}})).json();
 expect(identity.identity.policy).toEqual(rules);
 const forged=Buffer.from(JSON.stringify({v:1,sub:'casey',app:'semantic-canvas',iat:now,exp:now+120,rules:[]})).toString('base64url');
 expect((await(await fetch(u+'/api/auth/session',{headers:{cookie:`gw_session=${jwt}`,'x-gateway-policy':forged,'x-gateway-policy-sig':good.sig}})).json()).policy).toBeUndefined();
 const foreign=sign({v:1,sub:'someone-else',app:'semantic-canvas',iat:now,exp:now+120,rules});
 expect((await(await fetch(u+'/api/auth/session',{headers:{cookie:`gw_session=${jwt}`,'x-gateway-policy':foreign.body,'x-gateway-policy-sig':foreign.sig}})).json()).policy).toBeUndefined();
 const expired=sign({v:1,sub:'casey',app:'semantic-canvas',iat:now-300,exp:now-100,rules});
 expect((await(await fetch(u+'/api/auth/session',{headers:{cookie:`gw_session=${jwt}`,'x-gateway-policy':expired.body,'x-gateway-policy-sig':expired.sig}})).json()).policy).toBeUndefined();
 expect((await(await fetch(u+'/api/auth/session',{headers:{cookie:`gw_session=${jwt}`}})).json()).policy).toBeUndefined();
 await new Promise<void>(r=>s.close(()=>r()));
});
it('refuses a request that carries a policy it has no secret to verify, rather than serving it unscoped',async()=>{
 const {server:s,url:u}=await serve({groupsClaim:'groups',bindings});
 const jwt=await token();
 const r=await fetch(u+'/api/auth/session',{headers:{cookie:`gw_session=${jwt}`,'x-gateway-policy':'eyJ2IjoxfQ','x-gateway-policy-sig':'AA'}});
 expect(r.status).toBe(503);expect((await r.json()).error).toContain('SC_GATEWAY_POLICY_SECRET');
 expect((await fetch(u+'/api/auth/session',{headers:{cookie:`gw_session=${jwt}`}})).status).toBe(200);
 await new Promise<void>(r=>s.close(()=>r()));
});
