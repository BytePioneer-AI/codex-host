use std::ffi::{OsStr, OsString};

pub(crate) fn quote_windows_argument(argument: &OsStr) -> OsString {
    let value = argument.to_string_lossy();
    if !value.is_empty() && !value.contains([' ', '\t', '"']) {
        return argument.to_owned();
    }
    let mut output = String::from("\"");
    let mut backslashes = 0;
    for character in value.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                output.push_str(&"\\".repeat(backslashes * 2 + 1));
                output.push('"');
                backslashes = 0;
            }
            _ => {
                output.push_str(&"\\".repeat(backslashes));
                output.push(character);
                backslashes = 0;
            }
        }
    }
    output.push_str(&"\\".repeat(backslashes * 2));
    output.push('"');
    OsString::from(output)
}

pub(crate) fn windows_command_line(arguments: &[OsString]) -> OsString {
    arguments
        .iter()
        .map(|argument| quote_windows_argument(argument))
        .collect::<Vec<_>>()
        .join(OsStr::new(" "))
}
