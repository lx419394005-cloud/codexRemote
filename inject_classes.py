import re

with open('app/page.tsx', 'r') as f:
    content = f.read()

# Match style={s.someName} and inject className="someName"
# We also have to handle style={{ ...s.centerHero, ... }} -> className="centerHero"
# And style={s.navBtn(view === 'search')} -> className="navBtn"

def replace_style(match):
    full_match = match.group(0)
    style_content = match.group(1)
    
    # Try to extract the base name from s.xxx
    name_match = re.search(r's\.([a-zA-Z0-9_]+)', style_content)
    if name_match:
        class_name = name_match.group(1)
        return f'className="{class_name}" {full_match}'
    return full_match

new_content = re.sub(r'style=\{([^}]+)\}', replace_style, content)

with open('app/page.tsx', 'w') as f:
    f.write(new_content)

print("Done injecting classes.")
