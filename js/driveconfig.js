/* The ONE place that holds this app's Google Client ID and Google's addresses. tools/checks.mjs lets these exact
   addresses appear here and nowhere else in the app, so a new host cannot slip in unseen. The Content-Security-Policy in
   index.html lets the page send data requests to DRIVE_API + '/' and UPLOAD_API + '/' only (connect-src: two paths, not the
   whole host; tools/checks.mjs fails when the policy's two Google sources are not exactly these two); the sign-in is the page
   navigating to AUTH_URL, which a CSP does not govern. No script is ever loaded from Google.

   CLIENT_ID is public (it is sent in the address of every sign-in). There is no client secret and there never is one
   here: if Google ever seems to need one, that is a question for Jonathan, not something to work around. */
export const CLIENT_ID = '553752641676-d3mb2enmv622rpl2bjlfvqpfe7922h18.apps.googleusercontent.com';
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';        // the app sees only the files it made itself
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_NAME = 'ChartShark';

/* Where Google sends the person back to: the app's own start address ('../' from this file, so it is
   https://jhoffmanteacher.github.io/setlist-stand/ there and the loops' own server here), never typed. It has to equal
   the redirect address registered in Google's console, character for character. */
export const redirectUri = () => new URL('../', import.meta.url).href;
