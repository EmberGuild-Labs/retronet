// Credits for the eight third-party photos on the hidden era pages (research: .team/EGGS.md).
// Consumed by build-art.mjs to write the "Third-party photos" table in ASSETS.md.
// file is relative to src/renderer/public/; -1 is the computer, -2 the person.
const BY_SA_4 = ['CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0/']
const BY_SA_3 = ['CC BY-SA 3.0', 'https://creativecommons.org/licenses/by-sa/3.0/']
const BY_SA_2 = ['CC BY-SA 2.0', 'https://creativecommons.org/licenses/by-sa/2.0/']
const RESIZED = 'resized and metadata removed'
const c = (file, subject, author, [license, licenseUrl], source, modification = RESIZED) =>
  ({ file, subject, author, license, licenseUrl, source, modification })
const W = 'https://commons.wikimedia.org/wiki/'

export const EGG_CREDITS = [
  c('img/eggs/firstweb-1.jpg', 'NeXT Computer ("the Cube"), the first web server, Science Museum, London', 'Geni', BY_SA_4, W + 'File:NeXTcube_first_webserver.JPG'),
  c('img/eggs/firstweb-2.jpg', 'Sir Tim Berners-Lee', 'Paul Clarke', BY_SA_4, W + 'File:Sir_Tim_Berners-Lee_(cropped).jpg'),
  c('img/eggs/cascade-1.jpg', 'WebTV Internet Terminals (launch units)', 'Halen Martini', BY_SA_4, W + 'File:WebTV_Launch_Units.jpg'),
  c('img/eggs/cascade-2.jpg', 'Håkon Wium Lie, 2009', 'Martin Bekkelund / Friprog', BY_SA_2, W + 'File:H%C3%A5kon_Wium_Lie_2009.jpg'),
  c('img/eggs/clamshell-1.jpg', 'Apple iBook G3 (clamshell)', 'Felix Winkelnkemper', BY_SA_4, W + 'File:Apple_iBook_G3.jpg'),
  c('img/eggs/clamshell-2.jpg', 'Jeffrey Zeldman at SXSW, 2008', 'Jesús Gorriti (Flickr); square crop by Remember the dot', BY_SA_2,
    W + 'File:Jeffrey_Zeldman_@_SXSW_March_2008,_squared.jpeg', 'cropped, resized and metadata removed'),
  c('img/eggs/wikiwiki-1.jpg', 'Apple Power Mac G4 Cube', 'Binarysequence', BY_SA_4, W + 'File:Apple_Power_Mac_G4_Cube_-_Product_Shot.jpg'),
  c('img/eggs/wikiwiki-2.jpg', 'Ward Cunningham', 'Carrigg Photography for the Wikimedia Foundation', BY_SA_3, W + 'File:Ward_Cunningham_-_Commons-1_(cropped).jpg'),
]
