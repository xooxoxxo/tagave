-- A plan name the owner typed (renamed on the plan page or in the list) is
-- never rewritten afterwards: adding albums to a plan renames only names the
-- wizard made. False for every plan that existed before renaming did.
alter table tag_plans add column if not exists name_by_user boolean not null default false;
