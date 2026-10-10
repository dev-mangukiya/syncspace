-- Migration 011: Delete the remaining test accounts ending in @syncspace-test.internal
DELETE FROM file_versions WHERE author_id IN (SELECT id FROM users WHERE email LIKE '%@syncspace-test.internal');
DELETE FROM users WHERE email LIKE '%@syncspace-test.internal';
