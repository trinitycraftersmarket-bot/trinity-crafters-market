const ACTION_PERMISSION={
 'floor-attendees':'attendees',
 'floor-area-plans':'floor_plans',
 'floor-area-plans-save':'floor_plans',
 booking:'applications',
 photo:'applications',
 'rsvp-list':'shopper_rsvps',
 attendance:'attendees',
 'imported-attendance':'attendees',
 'checkin-reminder':'attendees',
 inspection:'attendees',
 'category-review-approve':'attendees',
 'payment-reminder-now':'applications'
};

export function hasStaffPermission(u,permission){
 return u?.admin===true||(u?.manager===true&&Array.isArray(u.permissions)&&u.permissions.includes(permission));
}

export function staffActionAllowed(u,action){
 if(u?.admin===true)return true;
 if(u?.manager!==true)return false;
 if(action==='manager')return true;
 const permission=ACTION_PERMISSION[action];
 return !!permission&&hasStaffPermission(u,permission);
}
