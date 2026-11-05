import { internalInvitationRoute } from './internal-invitation';
describe('internal invitation routing',()=>{
  const code='a'.repeat(43);
  it('keeps a valid group or community capability inside all Nivra clients',()=>{expect(internalInvitationRoute('https://nivrapp-secure.vercel.app/group/invite#'+code)).toBe('/group/invite#'+code);});
  it('does not turn external, malformed or credential-bearing links into trusted navigation',()=>{
    for(const link of ['javascript:alert(1)','https://evil.test/group/invite#'+code,'https://nivrapp-secure.vercel.app:8443/group/invite#'+code,'https://user@nivrapp-secure.vercel.app/group/invite#'+code,'https://nivrapp-secure.vercel.app/group/invite#bad'])expect(internalInvitationRoute(link)).toBeNull();
  });
});
