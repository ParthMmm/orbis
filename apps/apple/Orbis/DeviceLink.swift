import CoreImage.CIFilterBuiltins
import Foundation

#if canImport(UIKit)
  import UIKit
#endif

/// The Orbis service this app is built for (ADR 0018). The address is not a secret: every
/// request carries it, so the app knows it and a fresh install asks only for a sign-in.
enum OrbisService {
  static let address = URL(string: "https://orbis.p11a.xyz/api")!

  /// Where a signed-in device approves a Device Link (ADR 0016).
  static let approvalPage = "https://orbis.p11a.xyz/link"

  /// The address this launch signs in to. A Debug journey points it at the lane's service with
  /// `-orbisServiceAddress <address>`; every other build uses the built-in one.
  static func address(for arguments: [String]) -> URL {
    #if DEBUG
      if let flag = arguments.firstIndex(of: "-orbisServiceAddress"),
        arguments.indices.contains(flag + 1),
        let url = URL(string: arguments[flag + 1]), OrbisClient.accepts(url)
      {
        return url
      }
    #endif
    return address
  }
}

/// Signing a new device in with a code that a signed-in device approves (ADR 0016).
enum DeviceLink {
  /// How long the app waits between asks. The web client waits the same.
  static let pollInterval: Duration = .seconds(2)

  /// Shows `ABCDEFGH` as `ABCD-EFGH`, which is easier to read aloud and type.
  static func formatted(_ code: String) -> String {
    code.count == 8 ? "\(code.prefix(4))-\(code.suffix(4))" : code
  }

  /// The link a phone scans to approve this device. The code sits in the fragment, so no
  /// server or log sees it.
  static func approvalURL(for code: String) -> String {
    "\(OrbisService.approvalPage)#\(formatted(code))"
  }

  /// A QR code for `text`, drawn at whole-pixel scale so it stays sharp.
  static func qrCode(for text: String) -> CGImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
    else { return nil }
    return CIContext().createCGImage(output, from: output.extent)
  }

  /// The name the approving device sees. The Person may change it before asking for a code.
  @MainActor
  static var defaultLabel: String {
    #if canImport(UIKit)
      "Orbis on \(UIDevice.current.name)"
    #else
      "Orbis on \(Host.current().localizedName ?? "Mac")"
    #endif
  }
}

/// Where a Device Link sign-in stands.
enum DeviceLinkState: Equatable {
  case idle
  case starting
  /// Showing `userCode` and asking the service until someone approves it.
  case waiting(userCode: String)
  /// Nobody approved the code in time, or the service forgot it in a restart.
  case expired
}
