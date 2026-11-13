# Crate

Crate tracks the files a designer's working documents use and gathers them into a package. This glossary fixes the words Crate uses for those files and the decisions a designer makes about them.

## Language

### Files

**Working file**:
A document the designer works in, such as an InDesign or Photoshop file, whose assets Crate tracks.
_Avoid_: Source, source document

**Asset**:
A file a working file uses, such as an image (JPEG, PNG, PSD, AI) or a font, that can go into the package. A PSD or AI file can be a working file and an asset at the same time when it is placed in another working file.
_Avoid_: Link, dependency

**Existing**:
An asset the project already had when it started.
_Avoid_: Original, baseline

**Added**:
An asset that came into the project after it started, whether the designer used + Add Files or Crate found it while watching. It says where the asset came from, not whether it is Included.
_Avoid_: New

### Decisions

**Needs Review**:
The place where Crate lists files it found connected to the designer's work but cannot yet treat as Included. Some wait for the designer to save a working file, some are only open in a design app, and some wait for the designer to Include or Exclude them. Those last ones are marked "Include or Exclude".
_Avoid_: Pending, candidate

**Included**:
An asset or working file that will go into the package. Accepting a newly found asset under Needs Review and putting back something Excluded produce the same Included state.
_Avoid_: Added, Selected

**Include**:
The designer's action that makes an asset or working file Included. It is the exact opposite of Exclude and uses the same word everywhere, including for applying it to many at once.
_Avoid_: Add, Add All, Restore (Add is reserved for bringing files into the project)

**Excluded**:
An asset or working file the designer has chosen to leave out of the package. Leaving out a newly found asset under Needs Review and taking out something already in the package produce the same Excluded state.
_Avoid_: Skipped, left out

**Exclude**:
The designer's action that makes an asset or working file Excluded. The same word is used everywhere, including under Needs Review and for applying it to many at once.
_Avoid_: Skip, Skip All
