'use strict';

// Crate's verified-release font catalog: data only, bundled with the app, never
// fetched or updated at runtime. A font file is included automatically only when
// its exact bytes (SHA-256) match an entry here and every other font check passes.
// A match shows that the file is byte-identical to a published open-licence
// release; it does not prove anyone's rights to use or share it.
//
// Derivation (2026-11-12): google/fonts at commit 35e77c3854970a550d9894a85aba21420813a019.
// For each listed family directory: GitHub contents API listing at that commit,
// raw bytes per file, git blob SHA-1 checked against the listing, SHA-256 taken,
// METADATA.pb "license: OFL" and a per-file entry required, OFL.txt in the same
// directory checked to be the standard OFL 1.1 statement plus the canonical
// OFL 1.1 text, faces read with Crate's own reader and matched to METADATA.pb,
// no restricted embedding bit. Adding entries is a reviewed change to this file.

module.exports = {
 "schema": "crate-font-release-catalog/1",
 "derivedAt": "2026-11-12",
 "derivation": "catalog-evidence/fetch.sh + verify.cjs over google/fonts at the pinned commit",
 "licences": {
  "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/inter/OFL.txt": {
   "id": "OFL-1.1",
   "name": "Inter",
   "repository": "https://github.com/google/fonts",
   "commit": "35e77c3854970a550d9894a85aba21420813a019",
   "path": "ofl/inter/OFL.txt",
   "gitBlobSha1": "21f6aff961064c2e429f570995e446bcdd555422",
   "sha256": "5b9321a4298cfeb6b34354164a1c3afc3db114569984c502b9b35d988fd58c57",
   "text": "Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\nThis license is copied below, and is also available with a FAQ at:\nhttps://scripts.sil.org/OFL\n\n\n-----------------------------------------------------------\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----------------------------------------------------------\n\nPREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide\ndevelopment of collaborative font projects, to support the font creation\nefforts of academic and linguistic communities, and to provide a free and\nopen framework in which fonts may be shared and improved in partnership\nwith others.\n\nThe OFL allows the licensed fonts to be used, studied, modified and\nredistributed freely as long as they are not sold by themselves. The\nfonts, including any derivative works, can be bundled, embedded, \nredistributed and/or sold with any software provided that any reserved\nnames are not used by derivative works. The fonts and derivatives,\nhowever, cannot be released under any other type of license. The\nrequirement for fonts to remain under this license does not apply\nto any document created using the fonts or their derivatives.\n\nDEFINITIONS\n\"Font Software\" refers to the set of files released by the Copyright\nHolder(s) under this license and clearly marked as such. This may\ninclude source files, build scripts and documentation.\n\n\"Reserved Font Name\" refers to any names specified as such after the\ncopyright statement(s).\n\n\"Original Version\" refers to the collection of Font Software components as\ndistributed by the Copyright Holder(s).\n\n\"Modified Version\" refers to any derivative made by adding to, deleting,\nor substituting -- in part or in whole -- any of the components of the\nOriginal Version, by changing formats or by porting the Font Software to a\nnew environment.\n\n\"Author\" refers to any designer, engineer, programmer, technical\nwriter or other person who contributed to the Font Software.\n\nPERMISSION & CONDITIONS\nPermission is hereby granted, free of charge, to any person obtaining\na copy of the Font Software, to use, study, copy, merge, embed, modify,\nredistribute, and sell modified and unmodified copies of the Font\nSoftware, subject to the following conditions:\n\n1) Neither the Font Software nor any of its individual components,\nin Original or Modified Versions, may be sold by itself.\n\n2) Original or Modified Versions of the Font Software may be bundled,\nredistributed and/or sold with any software, provided that each copy\ncontains the above copyright notice and this license. These can be\nincluded either as stand-alone text files, human-readable headers or\nin the appropriate machine-readable metadata fields within text or\nbinary files as long as those fields can be easily viewed by the user.\n\n3) No Modified Version of the Font Software may use the Reserved Font\nName(s) unless explicit written permission is granted by the corresponding\nCopyright Holder. This restriction only applies to the primary font name as\npresented to the users.\n\n4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font\nSoftware shall not be used to promote, endorse or advertise any\nModified Version, except to acknowledge the contribution(s) of the\nCopyright Holder(s) and the Author(s) or with their explicit written\npermission.\n\n5) The Font Software, modified or unmodified, in part or in whole,\nmust be distributed entirely under this license, and must not be\ndistributed under any other license. The requirement for fonts to\nremain under this license does not apply to any document created\nusing the Font Software.\n\nTERMINATION\nThis license becomes null and void if any of the above conditions are\nnot met.\n\nDISCLAIMER\nTHE FONT SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT\nOF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE\nCOPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,\nINCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL\nDAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING\nFROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM\nOTHER DEALINGS IN THE FONT SOFTWARE.\n"
  },
  "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/montserrat/OFL.txt": {
   "id": "OFL-1.1",
   "name": "Montserrat",
   "repository": "https://github.com/google/fonts",
   "commit": "35e77c3854970a550d9894a85aba21420813a019",
   "path": "ofl/montserrat/OFL.txt",
   "gitBlobSha1": "fe576a2ee1f96353b05d030c0b7620d525cc53a8",
   "sha256": "8b7141c03fa4f8d44e6345d5d4931709290f0f67875e452e95ac1fd3a027802e",
   "text": "Copyright 2024 The Montserrat.Git Project Authors (https://github.com/JulietaUla/Montserrat.git)\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\nThis license is copied below, and is also available with a FAQ at:\nhttps://openfontlicense.org\n\n\n-----------------------------------------------------------\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----------------------------------------------------------\n\nPREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide\ndevelopment of collaborative font projects, to support the font creation\nefforts of academic and linguistic communities, and to provide a free and\nopen framework in which fonts may be shared and improved in partnership\nwith others.\n\nThe OFL allows the licensed fonts to be used, studied, modified and\nredistributed freely as long as they are not sold by themselves. The\nfonts, including any derivative works, can be bundled, embedded, \nredistributed and/or sold with any software provided that any reserved\nnames are not used by derivative works. The fonts and derivatives,\nhowever, cannot be released under any other type of license. The\nrequirement for fonts to remain under this license does not apply\nto any document created using the fonts or their derivatives.\n\nDEFINITIONS\n\"Font Software\" refers to the set of files released by the Copyright\nHolder(s) under this license and clearly marked as such. This may\ninclude source files, build scripts and documentation.\n\n\"Reserved Font Name\" refers to any names specified as such after the\ncopyright statement(s).\n\n\"Original Version\" refers to the collection of Font Software components as\ndistributed by the Copyright Holder(s).\n\n\"Modified Version\" refers to any derivative made by adding to, deleting,\nor substituting -- in part or in whole -- any of the components of the\nOriginal Version, by changing formats or by porting the Font Software to a\nnew environment.\n\n\"Author\" refers to any designer, engineer, programmer, technical\nwriter or other person who contributed to the Font Software.\n\nPERMISSION & CONDITIONS\nPermission is hereby granted, free of charge, to any person obtaining\na copy of the Font Software, to use, study, copy, merge, embed, modify,\nredistribute, and sell modified and unmodified copies of the Font\nSoftware, subject to the following conditions:\n\n1) Neither the Font Software nor any of its individual components,\nin Original or Modified Versions, may be sold by itself.\n\n2) Original or Modified Versions of the Font Software may be bundled,\nredistributed and/or sold with any software, provided that each copy\ncontains the above copyright notice and this license. These can be\nincluded either as stand-alone text files, human-readable headers or\nin the appropriate machine-readable metadata fields within text or\nbinary files as long as those fields can be easily viewed by the user.\n\n3) No Modified Version of the Font Software may use the Reserved Font\nName(s) unless explicit written permission is granted by the corresponding\nCopyright Holder. This restriction only applies to the primary font name as\npresented to the users.\n\n4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font\nSoftware shall not be used to promote, endorse or advertise any\nModified Version, except to acknowledge the contribution(s) of the\nCopyright Holder(s) and the Author(s) or with their explicit written\npermission.\n\n5) The Font Software, modified or unmodified, in part or in whole,\nmust be distributed entirely under this license, and must not be\ndistributed under any other license. The requirement for fonts to\nremain under this license does not apply to any document created\nusing the Font Software.\n\nTERMINATION\nThis license becomes null and void if any of the above conditions are\nnot met.\n\nDISCLAIMER\nTHE FONT SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT\nOF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE\nCOPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,\nINCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL\nDAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING\nFROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM\nOTHER DEALINGS IN THE FONT SOFTWARE."
  },
  "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/opensans/OFL.txt": {
   "id": "OFL-1.1",
   "name": "Open Sans",
   "repository": "https://github.com/google/fonts",
   "commit": "35e77c3854970a550d9894a85aba21420813a019",
   "path": "ofl/opensans/OFL.txt",
   "gitBlobSha1": "d762c3c4629d0950bfcb101ea82dd52b4ebf3707",
   "sha256": "fbbbcfef55318de350562559b671360de6d597112ecc5c73881b05092db89602",
   "text": "Copyright 2020 The Open Sans Project Authors (https://github.com/googlefonts/opensans)\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\nThis license is copied below, and is also available with a FAQ at:\nhttps://scripts.sil.org/OFL\n\n-----------------------------------------------------------\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----------------------------------------------------------\n\nPREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide\ndevelopment of collaborative font projects, to support the font\ncreation efforts of academic and linguistic communities, and to\nprovide a free and open framework in which fonts may be shared and\nimproved in partnership with others.\n\nThe OFL allows the licensed fonts to be used, studied, modified and\nredistributed freely as long as they are not sold by themselves. The\nfonts, including any derivative works, can be bundled, embedded,\nredistributed and/or sold with any software provided that any reserved\nnames are not used by derivative works. The fonts and derivatives,\nhowever, cannot be released under any other type of license. The\nrequirement for fonts to remain under this license does not apply to\nany document created using the fonts or their derivatives.\n\nDEFINITIONS\n\"Font Software\" refers to the set of files released by the Copyright\nHolder(s) under this license and clearly marked as such. This may\ninclude source files, build scripts and documentation.\n\n\"Reserved Font Name\" refers to any names specified as such after the\ncopyright statement(s).\n\n\"Original Version\" refers to the collection of Font Software\ncomponents as distributed by the Copyright Holder(s).\n\n\"Modified Version\" refers to any derivative made by adding to,\ndeleting, or substituting -- in part or in whole -- any of the\ncomponents of the Original Version, by changing formats or by porting\nthe Font Software to a new environment.\n\n\"Author\" refers to any designer, engineer, programmer, technical\nwriter or other person who contributed to the Font Software.\n\nPERMISSION & CONDITIONS\nPermission is hereby granted, free of charge, to any person obtaining\na copy of the Font Software, to use, study, copy, merge, embed,\nmodify, redistribute, and sell modified and unmodified copies of the\nFont Software, subject to the following conditions:\n\n1) Neither the Font Software nor any of its individual components, in\nOriginal or Modified Versions, may be sold by itself.\n\n2) Original or Modified Versions of the Font Software may be bundled,\nredistributed and/or sold with any software, provided that each copy\ncontains the above copyright notice and this license. These can be\nincluded either as stand-alone text files, human-readable headers or\nin the appropriate machine-readable metadata fields within text or\nbinary files as long as those fields can be easily viewed by the user.\n\n3) No Modified Version of the Font Software may use the Reserved Font\nName(s) unless explicit written permission is granted by the\ncorresponding Copyright Holder. This restriction only applies to the\nprimary font name as presented to the users.\n\n4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font\nSoftware shall not be used to promote, endorse or advertise any\nModified Version, except to acknowledge the contribution(s) of the\nCopyright Holder(s) and the Author(s) or with their explicit written\npermission.\n\n5) The Font Software, modified or unmodified, in part or in whole,\nmust be distributed entirely under this license, and must not be\ndistributed under any other license. The requirement for fonts to\nremain under this license does not apply to any document created using\nthe Font Software.\n\nTERMINATION\nThis license becomes null and void if any of the above conditions are\nnot met.\n\nDISCLAIMER\nTHE FONT SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT\nOF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE\nCOPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,\nINCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL\nDAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING\nFROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM\nOTHER DEALINGS IN THE FONT SOFTWARE.\n"
  },
  "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt": {
   "id": "OFL-1.1",
   "name": "Poppins",
   "repository": "https://github.com/google/fonts",
   "commit": "35e77c3854970a550d9894a85aba21420813a019",
   "path": "ofl/poppins/OFL.txt",
   "gitBlobSha1": "76df3b565672e3248a5715339d092d4cb6c75019",
   "sha256": "6be04893d770899a015649c7aa3b582f871b272f8747a92b78b17c3e5c8b2573",
   "text": "Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\nThis license is copied below, and is also available with a FAQ at:\nhttp://scripts.sil.org/OFL\n\n\n-----------------------------------------------------------\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----------------------------------------------------------\n\nPREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide\ndevelopment of collaborative font projects, to support the font creation\nefforts of academic and linguistic communities, and to provide a free and\nopen framework in which fonts may be shared and improved in partnership\nwith others.\n\nThe OFL allows the licensed fonts to be used, studied, modified and\nredistributed freely as long as they are not sold by themselves. The\nfonts, including any derivative works, can be bundled, embedded, \nredistributed and/or sold with any software provided that any reserved\nnames are not used by derivative works. The fonts and derivatives,\nhowever, cannot be released under any other type of license. The\nrequirement for fonts to remain under this license does not apply\nto any document created using the fonts or their derivatives.\n\nDEFINITIONS\n\"Font Software\" refers to the set of files released by the Copyright\nHolder(s) under this license and clearly marked as such. This may\ninclude source files, build scripts and documentation.\n\n\"Reserved Font Name\" refers to any names specified as such after the\ncopyright statement(s).\n\n\"Original Version\" refers to the collection of Font Software components as\ndistributed by the Copyright Holder(s).\n\n\"Modified Version\" refers to any derivative made by adding to, deleting,\nor substituting -- in part or in whole -- any of the components of the\nOriginal Version, by changing formats or by porting the Font Software to a\nnew environment.\n\n\"Author\" refers to any designer, engineer, programmer, technical\nwriter or other person who contributed to the Font Software.\n\nPERMISSION & CONDITIONS\nPermission is hereby granted, free of charge, to any person obtaining\na copy of the Font Software, to use, study, copy, merge, embed, modify,\nredistribute, and sell modified and unmodified copies of the Font\nSoftware, subject to the following conditions:\n\n1) Neither the Font Software nor any of its individual components,\nin Original or Modified Versions, may be sold by itself.\n\n2) Original or Modified Versions of the Font Software may be bundled,\nredistributed and/or sold with any software, provided that each copy\ncontains the above copyright notice and this license. These can be\nincluded either as stand-alone text files, human-readable headers or\nin the appropriate machine-readable metadata fields within text or\nbinary files as long as those fields can be easily viewed by the user.\n\n3) No Modified Version of the Font Software may use the Reserved Font\nName(s) unless explicit written permission is granted by the corresponding\nCopyright Holder. This restriction only applies to the primary font name as\npresented to the users.\n\n4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font\nSoftware shall not be used to promote, endorse or advertise any\nModified Version, except to acknowledge the contribution(s) of the\nCopyright Holder(s) and the Author(s) or with their explicit written\npermission.\n\n5) The Font Software, modified or unmodified, in part or in whole,\nmust be distributed entirely under this license, and must not be\ndistributed under any other license. The requirement for fonts to\nremain under this license does not apply to any document created\nusing the Font Software.\n\nTERMINATION\nThis license becomes null and void if any of the above conditions are\nnot met.\n\nDISCLAIMER\nTHE FONT SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT\nOF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE\nCOPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,\nINCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL\nDAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING\nFROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM\nOTHER DEALINGS IN THE FONT SOFTWARE.\n"
  },
  "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/roboto/OFL.txt": {
   "id": "OFL-1.1",
   "name": "Roboto",
   "repository": "https://github.com/google/fonts",
   "commit": "35e77c3854970a550d9894a85aba21420813a019",
   "path": "ofl/roboto/OFL.txt",
   "gitBlobSha1": "9c48e05a24fa2267e207ecf17560291b5621c197",
   "sha256": "061402327a96aadb0bfb694a960ed289ecd38d383e396243831ab81feb109c41",
   "text": "Copyright 2011 The Roboto Project Authors (https://github.com/googlefonts/roboto-classic)\n\nThis Font Software is licensed under the SIL Open Font License, Version 1.1.\nThis license is copied below, and is also available with a FAQ at:\nhttps://openfontlicense.org\n\n\n-----------------------------------------------------------\nSIL OPEN FONT LICENSE Version 1.1 - 26 February 2007\n-----------------------------------------------------------\n\nPREAMBLE\nThe goals of the Open Font License (OFL) are to stimulate worldwide\ndevelopment of collaborative font projects, to support the font creation\nefforts of academic and linguistic communities, and to provide a free and\nopen framework in which fonts may be shared and improved in partnership\nwith others.\n\nThe OFL allows the licensed fonts to be used, studied, modified and\nredistributed freely as long as they are not sold by themselves. The\nfonts, including any derivative works, can be bundled, embedded, \nredistributed and/or sold with any software provided that any reserved\nnames are not used by derivative works. The fonts and derivatives,\nhowever, cannot be released under any other type of license. The\nrequirement for fonts to remain under this license does not apply\nto any document created using the fonts or their derivatives.\n\nDEFINITIONS\n\"Font Software\" refers to the set of files released by the Copyright\nHolder(s) under this license and clearly marked as such. This may\ninclude source files, build scripts and documentation.\n\n\"Reserved Font Name\" refers to any names specified as such after the\ncopyright statement(s).\n\n\"Original Version\" refers to the collection of Font Software components as\ndistributed by the Copyright Holder(s).\n\n\"Modified Version\" refers to any derivative made by adding to, deleting,\nor substituting -- in part or in whole -- any of the components of the\nOriginal Version, by changing formats or by porting the Font Software to a\nnew environment.\n\n\"Author\" refers to any designer, engineer, programmer, technical\nwriter or other person who contributed to the Font Software.\n\nPERMISSION & CONDITIONS\nPermission is hereby granted, free of charge, to any person obtaining\na copy of the Font Software, to use, study, copy, merge, embed, modify,\nredistribute, and sell modified and unmodified copies of the Font\nSoftware, subject to the following conditions:\n\n1) Neither the Font Software nor any of its individual components,\nin Original or Modified Versions, may be sold by itself.\n\n2) Original or Modified Versions of the Font Software may be bundled,\nredistributed and/or sold with any software, provided that each copy\ncontains the above copyright notice and this license. These can be\nincluded either as stand-alone text files, human-readable headers or\nin the appropriate machine-readable metadata fields within text or\nbinary files as long as those fields can be easily viewed by the user.\n\n3) No Modified Version of the Font Software may use the Reserved Font\nName(s) unless explicit written permission is granted by the corresponding\nCopyright Holder. This restriction only applies to the primary font name as\npresented to the users.\n\n4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font\nSoftware shall not be used to promote, endorse or advertise any\nModified Version, except to acknowledge the contribution(s) of the\nCopyright Holder(s) and the Author(s) or with their explicit written\npermission.\n\n5) The Font Software, modified or unmodified, in part or in whole,\nmust be distributed entirely under this license, and must not be\ndistributed under any other license. The requirement for fonts to\nremain under this license does not apply to any document created\nusing the Font Software.\n\nTERMINATION\nThis license becomes null and void if any of the above conditions are\nnot met.\n\nDISCLAIMER\nTHE FONT SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND,\nEXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF\nMERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT\nOF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE\nCOPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,\nINCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL\nDAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING\nFROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM\nOTHER DEALINGS IN THE FONT SOFTWARE.\n"
  }
 },
 "entries": [
  {
   "sha256": "acd98e64795781b2058f07b18475e0ecee2a0fe2b42a49e2f9e37d0d6bf66ce6",
   "size": 906596,
   "family": "Inter",
   "collection": false,
   "faces": [
    "Inter-Italic"
   ],
   "variable": true,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/inter/Inter-Italic[opsz,wght].ttf",
    "gitBlobSha1": "c177578428248f08eedcc60e292acc6f414c2167"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/inter/OFL.txt"
  },
  {
   "sha256": "29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031",
   "size": 876576,
   "family": "Inter",
   "collection": false,
   "faces": [
    "Inter-Regular"
   ],
   "variable": true,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/inter/Inter[opsz,wght].ttf",
    "gitBlobSha1": "047c92f6e2212473dc436020afed689527076d44"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/inter/OFL.txt"
  },
  {
   "sha256": "51607f316bc020e59f03cbf51543eecffbea501c0b31d73e5b82927c5cca442c",
   "size": 762376,
   "family": "Montserrat",
   "collection": false,
   "faces": [
    "Montserrat-ThinItalic"
   ],
   "variable": true,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/montserrat/Montserrat-Italic[wght].ttf",
    "gitBlobSha1": "c8b8441744f2092ea8cbeb7b6f881e53bfe9c623"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/montserrat/OFL.txt"
  },
  {
   "sha256": "0f7b311b2f3279e4eef9b2f968bcdbab6e28f4daeb1f049f4f278a902bcd82f7",
   "size": 744936,
   "family": "Montserrat",
   "collection": false,
   "faces": [
    "Montserrat-Thin"
   ],
   "variable": true,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/montserrat/Montserrat[wght].ttf",
    "gitBlobSha1": "c97aca18592834d8706549c279cb8d5ac5d85f69"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/montserrat/OFL.txt"
  },
  {
   "sha256": "fe269381e992f32e135801740998544d6235061e37c93ec067ad2be3edd5b17b",
   "size": 583992,
   "family": "Open Sans",
   "collection": false,
   "faces": [
    "OpenSans-Italic"
   ],
   "variable": true,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/opensans/OpenSans-Italic[wdth,wght].ttf",
    "gitBlobSha1": "6c2997999ce43d4ab5b377b712f2b10aca5e4bc1"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/opensans/OFL.txt"
  },
  {
   "sha256": "36643644f318a812aab2d2ed3bb98f8cf0872527f835fe9398d95fe6b9adb878",
   "size": 532636,
   "family": "Open Sans",
   "collection": false,
   "faces": [
    "OpenSans-Regular"
   ],
   "variable": true,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/opensans/OpenSans[wdth,wght].ttf",
    "gitBlobSha1": "9db85693b027f3b05f6d77471d215f20707127c1"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/opensans/OFL.txt"
  },
  {
   "sha256": "d82aaaf98a9283f9a8edd24e51173337d8eaf09e25cd3d98831f8ec8461748a1",
   "size": 153440,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-Black"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-Black.ttf",
    "gitBlobSha1": "6612e5228fcdeabd840f4ca17de889ca447e22f4"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "f4852ca89c29f69d800e14f097ed4d1f0a0cc454e9f77d73bfd6db1f71c287a0",
   "size": 174116,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-BlackItalic"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-BlackItalic.ttf",
    "gitBlobSha1": "71a50d9ce6d2a04bb2c2aa20129485ba25a32b91"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "983676516167748b74de6f4771fb384c664fd913acb8b471122ecacf5da5ea6c",
   "size": 155996,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-Bold"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-Bold.ttf",
    "gitBlobSha1": "1982f38ab21303459aa1155265052ca599fa58d1"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "3572ac8116a0ac7317d342262b29937bcbaf94d8f03f90df6fe666fa7e2fb43a",
   "size": 179108,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-BoldItalic"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-BoldItalic.ttf",
    "gitBlobSha1": "43b6b9ee30852f1d94110403de25671e5533698e"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "f2ab17c1a63a0ecc12c2461848fc8a469395e3cd2d641803e889c643d9f958e1",
   "size": 154836,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-ExtraBold"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-ExtraBold.ttf",
    "gitBlobSha1": "167667d203d98f5b27c3ff58d486eea9c5287fe4"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "dc00a2eb988373e9f4e99bf8ff76c6315ee21d36b341cbbff024e4c18cc7ac03",
   "size": 176468,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-ExtraBoldItalic"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-ExtraBoldItalic.ttf",
    "gitBlobSha1": "c81b84a5ab0f5cf4682382fa685d4c5e0901986a"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "55c03314cc754e26f741f97890e5e9cbe3b3278fe3abcecfecafd60111b2643d",
   "size": 163568,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-ExtraLight"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-ExtraLight.ttf",
    "gitBlobSha1": "713d9e0bab2b8d1558d7892c537fdfd0129e6aa6"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "7171a17e4cda8f6ded78a7a931f9b7f38987057f3ffd1fe07a71528ad0f01e49",
   "size": 188748,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-ExtraLightItalic"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-ExtraLightItalic.ttf",
    "gitBlobSha1": "4dbabd4e635131f74bc44b9e93f4f0a5d0d19c32"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "4fa76ae75b40f926420514044722cb97f32186cafd3b38263cc34dad7174d46d",
   "size": 184544,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-Italic"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-Italic.ttf",
    "gitBlobSha1": "8631652654966ed9fe10bd5b6cda0d8337866117"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "650ba57fa99d12ec40c31ccfb680be656be4497fbe14164617d67e32ffe9cd46",
   "size": 161936,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-Light"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-Light.ttf",
    "gitBlobSha1": "931ae8fdc6a32eaa6666f31343f5cd37e74954a4"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "b8f9c5be59723fadf8e5447fa1245c2c53b60a3464a24d6ece9ee3c283d8917b",
   "size": 186976,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-LightItalic"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-LightItalic.ttf",
    "gitBlobSha1": "edb975b0bb45d41a037ef95b294d5cab24e92932"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "90373e7d838d32468438fc3e152dca0bdb12edcab99ea639f158790b1ba1fd05",
   "size": 158576,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-Medium"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-Medium.ttf",
    "gitBlobSha1": "a590f5c3e4902a7cb10f4bbc5da0e65e667f7950"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "765addf6c7c11ec3c54325cacd68cabd05df8e4b6455302d812a9b9bafd1c614",
   "size": 183012,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-MediumItalic"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-MediumItalic.ttf",
    "gitBlobSha1": "75011beeb5f0c7450f83639e16b54f68f7685f9f"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "7e65201e9b79159e2300267cc885e16c8dcef2424cdfa09a29bfb0980a94a7ba",
   "size": 160316,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-Regular"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-Regular.ttf",
    "gitBlobSha1": "0bda228ade88b0bb5aac7da2c881d0c3f64d0817"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "d3bf1bdaf0550e83da9ac0b1d1d9fe6db086835a83aa28578e609a394b9a0286",
   "size": 157312,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-SemiBold"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-SemiBold.ttf",
    "gitBlobSha1": "c30ad104723a0e6e00e54768626cb02c5fdf6aee"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "16bb118aa232c9a13fa238027d24d7854dd1a1d9cbaf99b17fec4388d56b432c",
   "size": 181108,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-SemiBoldItalic"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-SemiBoldItalic.ttf",
    "gitBlobSha1": "a1352f273bfa694d7b2c9c1fd65ba9e4de380830"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "6d8e5d9d29140cc93e321745fa1243c67889e6bc3639ec34db64f3da7a496352",
   "size": 163672,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-Thin"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-Thin.ttf",
    "gitBlobSha1": "92f799718d8c9882252b57d3778010b253dcf38e"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "46df80ac970f5e84829b868d283878b4d97e289c7b1245541d8bbf66b5d670a8",
   "size": 189552,
   "family": "Poppins",
   "collection": false,
   "faces": [
    "Poppins-ThinItalic"
   ],
   "variable": false,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/poppins/Poppins-ThinItalic.ttf",
    "gitBlobSha1": "d7353bd6b8795ac4bf9980741e95cac0eda53a51"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/poppins/OFL.txt"
  },
  {
   "sha256": "9725a847af6b460ffca162ae66d20dad48b01876137947180b42d7dcd7887182",
   "size": 530944,
   "family": "Roboto",
   "collection": false,
   "faces": [
    "Roboto-Italic"
   ],
   "variable": true,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/roboto/Roboto-Italic[wdth,wght].ttf",
    "gitBlobSha1": "a122c13964daac37f1186a22603a5180d2dba5d6"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/roboto/OFL.txt"
  },
  {
   "sha256": "d7598e12c5dbef095ff8272cfc55da0250bd07fbdecbac8a530b9b277872a134",
   "size": 488584,
   "family": "Roboto",
   "collection": false,
   "faces": [
    "Roboto-Regular"
   ],
   "variable": true,
   "source": {
    "repository": "https://github.com/google/fonts",
    "commit": "35e77c3854970a550d9894a85aba21420813a019",
    "path": "ofl/roboto/Roboto[wdth,wght].ttf",
    "gitBlobSha1": "5522a368d9072fd88c299916e61fcff369949061"
   },
   "licence": "google-fonts/35e77c3854970a550d9894a85aba21420813a019/ofl/roboto/OFL.txt"
  }
 ]
};
