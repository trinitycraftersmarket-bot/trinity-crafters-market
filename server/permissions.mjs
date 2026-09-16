export function staffActionAllowed(u,action){return u.admin===true||(u.manager===true&&['manager','booking','photo','rsvp-list'].includes(action));}
