import { signal } from '@angular/core';
import { ContactsPage } from './contacts.page';
import { identityDisplayName } from '../../core/utils/nivra-identity';

describe('Contacts directory and self notes', () => {
  it('searches accents, aliases and IDs locally without changing saved contacts', () => {
    const page: any = Object.create(ContactsPage.prototype);
    const contacts = [
      { userId:'sofia',alias:'sofi',displayName:'Sofía Martínez',isFavorite:false,nivraNumber:'NV-100' },
      { userId:'alex',alias:'alex',displayName:'Alex',isFavorite:true },
    ];
    page.social={contacts:signal(contacts)}; page.personName=identityDisplayName;
    page.query='martinez SOFIA';expect(page.filteredContacts().map((contact: any)=>contact.userId)).toEqual(['sofia']);
    page.query='NV-100';expect(page.filteredContacts().length).toBe(1);
    page.query='';expect(page.filteredContacts()[0].userId).toBe('alex');
    expect(contacts[0].userId).toBe('sofia');
  });

  it('opens notes for the exact current account using the normal encrypted conversation flow', async () => {
    const page: any=Object.create(ContactsPage.prototype);
    page.auth={session:()=>({user:{id:'own-user',alias:'alex'}})};
    page.openPerson=jasmine.createSpy().and.resolveTo();
    await page.openSelf();
    expect(page.openPerson.calls.first().args[0].id).toBe('own-user');
    expect(page.openPerson.calls.first().args[0].isContact).toBeFalse();
  });
});
