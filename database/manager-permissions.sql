alter table market.staff
  add column if not exists permissions jsonb not null
  default '["applications","attendees","waitlist","shopper_rsvps","vendor_messages"]'::jsonb;

update market.staff
set permissions='["applications","attendees","waitlist","shopper_rsvps","vendor_messages"]'::jsonb
where permissions is null or jsonb_typeof(permissions) <> 'array';
