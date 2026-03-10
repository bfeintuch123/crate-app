#!/usr/bin/swift
// Creates a Finder alias file pointing to /Applications
// Usage: swift create-alias.swift <output-alias-path> [icon-icns-path]

import Foundation
import AppKit

guard CommandLine.arguments.count >= 2 else {
    print("Usage: create-alias <output-path> [icon-icns-path]")
    exit(1)
}

let outputPath = CommandLine.arguments[1]
let iconPath = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : nil

let targetURL = URL(fileURLWithPath: "/Applications")
let outputURL = URL(fileURLWithPath: outputPath)

do {
    // Create bookmark data (which is what modern macOS aliases are)
    let bookmarkData = try targetURL.bookmarkData(
        options: .suitableForBookmarkFile,
        includingResourceValuesForKeys: nil,
        relativeTo: nil
    )

    // Write as alias file
    try URL.writeBookmarkData(bookmarkData, to: outputURL)

    // Set the alias name to "Applications"
    // The file is already created, now set custom icon if provided
    if let iconPath = iconPath {
        let iconURL = URL(fileURLWithPath: iconPath)
        if let iconImage = NSImage(contentsOf: iconURL) {
            NSWorkspace.shared.setIcon(iconImage, forFile: outputPath)
            print("Set custom icon from \(iconPath)")
        } else {
            print("Warning: Could not load icon from \(iconPath)")
        }
    }

    print("Created Finder alias at \(outputPath) -> /Applications")
} catch {
    print("Error: \(error)")
    exit(1)
}
